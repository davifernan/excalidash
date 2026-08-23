import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import {
  originalKey,
  removeStored,
  resolveStoragePath,
  storeStream,
} from "../../assets/assetStorage";
import { processFilesForS3 } from "../../fileProcessing";
import {
  ImportValidationError,
  RegisterImportExportDeps,
  getUserTrashCollectionId,
  resolveSafeUploadedFilePath,
} from "./shared";
import {
  PreparedDrawing,
  PreparedSnapshot,
  assertSceneMemoryBudget,
  canonicalMimeType,
  openArchive,
  parseManifest,
  parseScene,
  remapAssetIds,
  requireEntry,
  validateManifestReferences,
  verifyEntrySha256,
} from "./excalidashImportSupport";
import { claimOnBoard, claimOnCollection } from "../../authz/boards";

export const registerExcalidashImportRoutes = (deps: RegisterImportExportDeps) => {
  const { app, prisma, requireAuth, asyncHandler, upload, uploadDir } = deps;

  app.post(
    "/import/excalidash/verify",
    requireAuth,
    upload.single("archive"),
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      let stagedPath: string | undefined;
      try {
        stagedPath = await resolveSafeUploadedFilePath({ filename: req.file.filename }, uploadDir);
        const archive = await openArchive(stagedPath, deps);
        const budget = {
          extractedBytes: 0,
          maxExtractedBytes: deps.MAX_IMPORT_TOTAL_EXTRACTED_BYTES,
        };
        const manifest = await parseManifest(archive, budget, deps.MAX_IMPORT_MANIFEST_BYTES);
        validateManifestReferences(archive, manifest, deps);
        if (manifest.formatVersion === 2) {
          for (const blob of manifest.blobs) {
            await verifyEntrySha256(
              archive,
              requireEntry(archive, blob.filePath),
              blob.sha256,
              budget,
            );
          }
        }
        return res.json({
          valid: true,
          formatVersion: manifest.formatVersion,
          exportedAt: manifest.exportedAt,
          excalidashBackendVersion: manifest.excalidashBackendVersion || null,
          collections: manifest.collections.length,
          drawings: manifest.drawings.length,
          documents: manifest.formatVersion === 2 ? manifest.assets.length : 0,
        });
      } catch (error) {
        if (error instanceof ImportValidationError) {
          return res.status(error.status).json({ error: "Invalid backup", message: error.message });
        }
        throw error;
      } finally {
        await deps.removeFileIfExists(stagedPath);
      }
    }),
  );

  app.post(
    "/import/excalidash",
    requireAuth,
    upload.single("archive"),
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      let stagedPath: string | undefined;
      const writtenStorageKeys: string[] = [];
      let committed = false;
      try {
        stagedPath = await resolveSafeUploadedFilePath({ filename: req.file.filename }, uploadDir);
        const archive = await openArchive(stagedPath, deps);
        const budget = {
          extractedBytes: 0,
          maxExtractedBytes: deps.MAX_IMPORT_TOTAL_EXTRACTED_BYTES,
        };
        const manifest = await parseManifest(archive, budget, deps.MAX_IMPORT_MANIFEST_BYTES);
        validateManifestReferences(archive, manifest, deps);

        const sceneMemoryLimit = deps.MAX_IMPORT_SCENE_MEMORY_BYTES ?? 64 * 1024 * 1024;
        assertSceneMemoryBudget(archive, manifest, sceneMemoryLimit);

        const preparedDrawings: PreparedDrawing[] = [];
        for (const drawing of manifest.drawings) {
          const raw = await archive.readBuffer(
            requireEntry(archive, drawing.filePath),
            deps.MAX_IMPORT_DRAWING_BYTES,
            budget,
          );
          preparedDrawings.push({
            id: drawing.id,
            name: deps.sanitizeText(drawing.name, 255) || "Untitled Drawing",
            version: drawing.version,
            collectionId: drawing.collectionId,
            sanitized: parseScene(raw, drawing, deps.validateImportedDrawing),
          });
        }

        const preparedSnapshots: PreparedSnapshot[] = [];
        if (manifest.formatVersion === 2) {
          for (const snapshot of manifest.snapshots) {
            const raw = await archive.readBuffer(
              requireEntry(archive, snapshot.filePath),
              deps.MAX_IMPORT_ENTRY_BYTES,
              budget,
            );
            preparedSnapshots.push({
              ...snapshot,
              sanitized: parseScene(raw, { name: "Snapshot" }, deps.validateImportedDrawing),
            });
          }
        }

        const finalDrawingIdMap = new Map<string, string>();
        for (const prepared of preparedDrawings) {
          // An id that belongs to somebody else is re-keyed, never overwritten.
          // "absent" and "owned" both keep the id; only a foreign claim moves it.
          const claim = await claimOnBoard({
            db: prisma,
            userId: req.user.id,
            boardId: prepared.id,
          });
          finalDrawingIdMap.set(prepared.id, claim === "foreign" ? uuidv4() : prepared.id);
        }

        const assetIdMap = new Map<string, string>();
        const blobIdMap = new Map<string, string>();
        const newBlobRows = new Map<string, any>();
        const repairedBlobRows = new Map<string, any>();
        if (manifest.formatVersion === 2) {
          for (const asset of manifest.assets) assetIdMap.set(asset.id, randomUUID());
          for (const prepared of preparedDrawings)
            remapAssetIds(prepared.sanitized.elements, assetIdMap);
          for (const snapshot of preparedSnapshots)
            remapAssetIds(snapshot.sanitized.elements, assetIdMap);

          for (const blob of manifest.blobs) {
            const entry = requireEntry(archive, blob.filePath);
            const existing = await prisma.storedBlob.findUnique({ where: { sha256: blob.sha256 } });
            if (existing) {
              blobIdMap.set(blob.id, existing.id);
              let fileExists = false;
              try {
                fileExists = (
                  await fs.lstat(resolveStoragePath(deps.assetStorageDir, existing.storageKey))
                ).isFile();
              } catch {}
              if (fileExists) {
                await verifyEntrySha256(archive, entry, blob.sha256, budget);
                continue;
              }
              const storageKey = originalKey(existing.id);
              const stored = await storeStream(
                deps.assetStorageDir,
                storageKey,
                await archive.stream(entry, budget),
                deps.MAX_IMPORT_ENTRY_BYTES,
                { compress: blob.contentEncoding === "br" },
              );
              writtenStorageKeys.push(stored.storageKey);
              if (stored.sha256 !== blob.sha256 || stored.sizeBytes !== blob.sizeBytes) {
                throw new ImportValidationError(`Document sha256 mismatch: ${blob.filePath}`);
              }
              repairedBlobRows.set(existing.id, stored);
              continue;
            }

            const finalBlobId = randomUUID();
            const stored = await storeStream(
              deps.assetStorageDir,
              originalKey(finalBlobId),
              await archive.stream(entry, budget),
              deps.MAX_IMPORT_ENTRY_BYTES,
              { compress: blob.contentEncoding === "br" },
            );
            writtenStorageKeys.push(stored.storageKey);
            if (stored.sha256 !== blob.sha256 || stored.sizeBytes !== blob.sizeBytes) {
              throw new ImportValidationError(`Document sha256 mismatch: ${blob.filePath}`);
            }
            blobIdMap.set(blob.id, finalBlobId);
            newBlobRows.set(finalBlobId, stored);
          }
        }

        const processedFilesMap = new Map<string, Record<string, any>>();
        const concurrency = 8;
        for (let start = 0; start < preparedDrawings.length; start += concurrency) {
          const batch = preparedDrawings
            .slice(start, start + concurrency)
            .map(async (prepared) => ({
              id: prepared.id,
              files: await processFilesForS3(
                prepared.sanitized.files || {},
                req.user!.id,
                finalDrawingIdMap.get(prepared.id)!,
                prisma,
              ),
            }));
          for (const result of await Promise.all(batch))
            processedFilesMap.set(result.id, result.files);
        }

        const result = await prisma.$transaction(async (tx) => {
          for (const [id, stored] of newBlobRows) {
            await tx.storedBlob.create({
              data: {
                id,
                sha256: stored.sha256,
                sizeBytes: stored.sizeBytes,
                storedBytes: stored.storedBytes,
                contentEncoding: stored.contentEncoding,
                storageKey: stored.storageKey,
                state: "READY",
              },
            });
          }
          for (const [id, stored] of repairedBlobRows) {
            await tx.storedBlob.update({
              where: { id },
              data: {
                sizeBytes: stored.sizeBytes,
                storedBytes: stored.storedBytes,
                contentEncoding: stored.contentEncoding,
                storageKey: stored.storageKey,
                state: "READY",
                deleteAfter: null,
              },
            });
          }

          const trashCollectionId = getUserTrashCollectionId(req.user!.id);
          const collectionIdMap = new Map<string, string>();
          let collectionsCreated = 0;
          let collectionsUpdated = 0;
          let collectionIdConflicts = 0;
          let drawingsCreated = 0;
          let drawingsUpdated = 0;
          let drawingIdConflicts = 0;
          const needsTrash =
            manifest.collections.some((item) => item.id === "trash") ||
            preparedDrawings.some((item) => item.collectionId === "trash");
          if (needsTrash) await deps.ensureTrashCollection(tx, req.user!.id);

          for (const collection of manifest.collections) {
            if (collection.id === "trash") {
              collectionIdMap.set("trash", trashCollectionId);
              continue;
            }
            const claim = await claimOnCollection({
              db: tx,
              userId: req.user!.id,
              collectionId: collection.id,
            });
            const name = deps.sanitizeText(collection.name, 100) || "Collection";
            if (claim === "absent") {
              await tx.collection.create({
                data: { id: collection.id, name, userId: req.user!.id },
              });
              collectionIdMap.set(collection.id, collection.id);
              collectionsCreated += 1;
            } else if (claim === "owned") {
              await tx.collection.update({ where: { id: collection.id }, data: { name } });
              collectionIdMap.set(collection.id, collection.id);
              collectionsUpdated += 1;
            } else {
              const newId = uuidv4();
              await tx.collection.create({ data: { id: newId, name, userId: req.user!.id } });
              collectionIdMap.set(collection.id, newId);
              collectionsCreated += 1;
              collectionIdConflicts += 1;
            }
          }
          const resolveCollectionId = (id: string | null) => {
            if (!id) return null;
            if (id === "trash") return trashCollectionId;
            return collectionIdMap.get(id) || null;
          };

          for (const prepared of preparedDrawings) {
            const boardClaim = await claimOnBoard({
              db: tx,
              userId: req.user!.id,
              boardId: prepared.id,
            });
            const finalId = finalDrawingIdMap.get(prepared.id)!;
            const data = {
              name: prepared.name,
              elements: JSON.stringify(prepared.sanitized.elements),
              appState: JSON.stringify(prepared.sanitized.appState),
              files: JSON.stringify(processedFilesMap.get(prepared.id) ?? {}),
              preview: prepared.sanitized.preview ?? null,
              version: prepared.version ?? 1,
              collectionId: resolveCollectionId(prepared.collectionId),
            };
            if (boardClaim !== "owned") {
              await tx.drawing.create({ data: { id: finalId, ...data, userId: req.user!.id } });
              drawingsCreated += 1;
              if (boardClaim === "foreign") drawingIdConflicts += 1;
            } else {
              await tx.drawing.update({ where: { id: prepared.id }, data });
              await tx.drawingAsset.deleteMany({ where: { drawingId: prepared.id } });
              drawingsUpdated += 1;
            }
          }

          if (manifest.formatVersion === 2) {
            for (const asset of manifest.assets) {
              await tx.asset.create({
                data: {
                  id: assetIdMap.get(asset.id)!,
                  ownerUserId: req.user!.id,
                  uploadedByUserId: req.user!.id,
                  blobId: blobIdMap.get(asset.blobId)!,
                  kind: asset.kind,
                  originalName: asset.originalName.slice(0, 255),
                  // MIME controls response headers and is therefore derived from
                  // the validated kind, never trusted from the imported file.
                  mimeType: canonicalMimeType(asset.kind),
                  pageCount: asset.pageCount,
                  status: "READY",
                },
              });
            }
            for (const link of manifest.drawingAssets) {
              await tx.drawingAsset.create({
                data: {
                  drawingId: finalDrawingIdMap.get(link.drawingId)!,
                  assetId: assetIdMap.get(link.assetId)!,
                  state: link.state,
                  expiresAt: link.expiresAt ? new Date(link.expiresAt) : null,
                },
              });
            }
            for (const snapshot of preparedSnapshots) {
              const snapshotId = randomUUID();
              await tx.drawingSnapshot.create({
                data: {
                  id: snapshotId,
                  drawingId: finalDrawingIdMap.get(snapshot.drawingId)!,
                  version: snapshot.version,
                  elements: JSON.stringify(snapshot.sanitized.elements),
                  appState: JSON.stringify(snapshot.sanitized.appState),
                  files: JSON.stringify(snapshot.sanitized.files || {}),
                  createdAt: snapshot.createdAt ? new Date(snapshot.createdAt) : undefined,
                },
              });
              for (const oldAssetId of snapshot.assetIds) {
                await tx.drawingSnapshotAsset.create({
                  data: { snapshotId, assetId: assetIdMap.get(oldAssetId)! },
                });
              }
            }
          }
          return {
            collections: {
              created: collectionsCreated,
              updated: collectionsUpdated,
              idConflicts: collectionIdConflicts,
            },
            drawings: {
              created: drawingsCreated,
              updated: drawingsUpdated,
              idConflicts: drawingIdConflicts,
            },
            documents: manifest.formatVersion === 2 ? manifest.assets.length : 0,
          };
        });
        committed = true;
        deps.invalidateDrawingsCache();
        return res.json({ success: true, message: "Backup imported successfully", ...result });
      } catch (error) {
        if (error instanceof ImportValidationError) {
          return res.status(error.status).json({ error: "Invalid backup", message: error.message });
        }
        throw error;
      } finally {
        if (!committed) {
          await Promise.allSettled(
            writtenStorageKeys.map((key) => removeStored(deps.assetStorageDir, key)),
          );
        }
        await deps.removeFileIfExists(stagedPath);
      }
    }),
  );
};
