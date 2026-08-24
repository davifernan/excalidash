import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { createBrotliDecompress } from "node:zlib";
import archiver from "archiver";
import { logger } from "../../logger";
import { resolveStoragePath } from "../../assets/assetStorage";
import { decodeSnapshotField } from "../../snapshots/snapshotCodec";
import {
  ownedBoardsWhere,
  ownedCollectionsWhere,
  throughOwnedBoardWhere,
} from "../../authz/boards";
import {
  RegisterImportExportDeps,
  assertSafeArchivePath,
  getUserTrashCollectionId,
  isTrashCollectionId,
  makeUniqueName,
  sanitizePathSegment,
  toPublicTrashCollectionId,
} from "./shared";

export const registerExcalidashExportRoute = (deps: RegisterImportExportDeps) => {
  const { app, prisma, requireAuth, asyncHandler, getBackendVersion, parseJsonField } = deps;

  app.get(
    "/export/excalidash",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const trashCollectionId = getUserTrashCollectionId(req.user.id);

      const extParam = typeof req.query.ext === "string" ? req.query.ext.toLowerCase() : "";
      const zipSuffix = extParam === "zip";
      const date = new Date().toISOString().split("T")[0];
      const filename = zipSuffix
        ? `excalidash-backup-${date}.excalidash.zip`
        : `excalidash-backup-${date}.excalidash`;

      const exportedAt = new Date().toISOString();
      const drawings = await prisma.drawing.findMany({
        where: ownedBoardsWhere(req.user.id),
        select: {
          id: true,
          name: true,
          collectionId: true,
          version: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const userCollections = await prisma.collection.findMany({
        where: ownedCollectionsWhere(req.user.id),
      });
      const drawingAssetRows = await prisma.drawingAsset.findMany({
        where: throughOwnedBoardWhere(req.user.id),
        include: { asset: { include: { blob: true } } },
      });
      const snapshots = await prisma.drawingSnapshot.findMany({
        where: throughOwnedBoardWhere(req.user.id),
        select: {
          id: true,
          drawingId: true,
          version: true,
          createdAt: true,
          assets: { select: { assetId: true, asset: { include: { blob: true } } } },
        },
      });

      const hasInternalTrashCollection = userCollections.some(
        (collection) => collection.id === trashCollectionId,
      );
      const normalizedUserCollections = userCollections.filter(
        (collection) => !(hasInternalTrashCollection && collection.id === "trash"),
      );
      const hasTrashDrawings = drawings.some((drawing) =>
        isTrashCollectionId(drawing.collectionId, req.user!.id),
      );
      const collectionsToExport = [...normalizedUserCollections];
      if (
        hasTrashDrawings &&
        !collectionsToExport.some((collection) => isTrashCollectionId(collection.id, req.user!.id))
      ) {
        const trash = await prisma.collection.findFirst({
          where: {
            ...ownedCollectionsWhere(req.user.id),
            id: { in: [trashCollectionId, "trash"] },
          },
        });
        if (trash) collectionsToExport.push(trash);
      }

      const exportSource = `${req.protocol}://${req.get("host")}`;
      const usedFolderNames = new Set<string>();
      const unorganizedFolder = makeUniqueName("Unorganized", usedFolderNames);
      const folderByCollectionId = new Map<string, string>();
      for (const collection of collectionsToExport) {
        const folder = makeUniqueName(
          sanitizePathSegment(collection.name, "Collection"),
          usedFolderNames,
        );
        folderByCollectionId.set(collection.id, folder);
      }

      const drawingsManifest = drawings.map((drawing) => {
        const folder = drawing.collectionId
          ? folderByCollectionId.get(drawing.collectionId) || unorganizedFolder
          : unorganizedFolder;
        const fileName = `${sanitizePathSegment(drawing.name, "Untitled")}__${drawing.id.slice(0, 8)}.excalidraw`;
        return {
          id: drawing.id,
          name: drawing.name,
          filePath: `${folder}/${fileName}`,
          collectionId: toPublicTrashCollectionId(drawing.collectionId, req.user!.id),
          version: drawing.version,
          createdAt: drawing.createdAt.toISOString(),
          updatedAt: drawing.updatedAt.toISOString(),
        };
      });
      const manifestCollections = collectionsToExport
        .map((collection) => ({
          id: toPublicTrashCollectionId(collection.id, req.user!.id) || collection.id,
          name: isTrashCollectionId(collection.id, req.user!.id) ? "Trash" : collection.name,
          folder:
            folderByCollectionId.get(collection.id) ||
            sanitizePathSegment(collection.name, "Collection"),
          createdAt: collection.createdAt.toISOString(),
          updatedAt: collection.updatedAt.toISOString(),
        }))
        .filter(
          (collection, index, all) =>
            all.findIndex((candidate) => candidate.id === collection.id) === index,
        );

      const assetsById = new Map<string, any>();
      for (const row of drawingAssetRows as any[]) assetsById.set(row.asset.id, row.asset);
      for (const snapshot of snapshots as any[]) {
        for (const row of snapshot.assets) assetsById.set(row.asset.id, row.asset);
      }
      const blobsById = new Map<string, any>();
      for (const asset of assetsById.values()) blobsById.set(asset.blob.id, asset.blob);

      const blobManifest = [...blobsById.values()].map((blob) => ({
        id: blob.id,
        filePath: `assets/originals/${blob.sha256}`,
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
        contentEncoding: blob.contentEncoding === "br" ? ("br" as const) : null,
      }));
      const assetManifest = [...assetsById.values()].map((asset) => ({
        id: asset.id,
        blobId: asset.blobId,
        kind: asset.kind,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        pageCount: asset.pageCount,
        status: asset.status,
      }));
      const snapshotManifest = (snapshots as any[]).map((snapshot) => ({
        id: snapshot.id,
        drawingId: snapshot.drawingId,
        filePath: `snapshots/${snapshot.id}.json`,
        version: snapshot.version,
        createdAt: snapshot.createdAt.toISOString(),
        assetIds: snapshot.assets.map((row: any) => row.assetId),
      }));
      const manifest = {
        format: "excalidash" as const,
        formatVersion: 2 as const,
        exportedAt,
        excalidashBackendVersion: getBackendVersion(),
        userId: req.user.id,
        unorganizedFolder,
        collections: manifestCollections,
        drawings: drawingsManifest,
        blobs: blobManifest,
        assets: assetManifest,
        drawingAssets: (drawingAssetRows as any[]).map((row) => ({
          drawingId: row.drawingId,
          assetId: row.assetId,
          state: row.state,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        })),
        snapshots: snapshotManifest,
      };
      const pdfBlobIds = new Set(
        [...assetsById.values()]
          .filter((asset) => asset.mimeType === "application/pdf")
          .map((asset) => asset.blobId),
      );

      const serializeDrawing = (drawing: any) =>
        JSON.stringify(
          {
            type: "excalidraw" as const,
            version: 2 as const,
            source: exportSource,
            elements: parseJsonField(drawing.elements, [] as unknown[]),
            appState: parseJsonField(drawing.appState, {} as Record<string, unknown>),
            files: parseJsonField(drawing.files, {} as Record<string, unknown>),
            excalidash: {
              drawingId: drawing.id,
              collectionId: drawing.collectionId ?? null,
              exportedAt,
            },
          },
          null,
          2,
        );
      const serializeSnapshot = (snapshot: any) =>
        JSON.stringify({
          type: "excalidash-snapshot",
          version: snapshot.version,
          elements: parseJsonField(decodeSnapshotField(snapshot.elements), [] as unknown[]),
          appState: parseJsonField(
            decodeSnapshotField(snapshot.appState),
            {} as Record<string, unknown>,
          ),
          files: parseJsonField(decodeSnapshotField(snapshot.files), {} as Record<string, unknown>),
        });

      const manifestJson = JSON.stringify(manifest, null, 2);
      if (Buffer.byteLength(manifestJson) > deps.MAX_IMPORT_MANIFEST_BYTES) {
        return res.status(413).json({ error: "Backup manifest is too large" });
      }
      let exportedBytes = Buffer.byteLength(manifestJson);
      for (const drawing of drawings) {
        const scene = await prisma.drawing.findUnique({
          where: { id: drawing.id },
          select: { id: true, collectionId: true, elements: true, appState: true, files: true },
        });
        if (!scene) throw new Error(`Drawing disappeared during export: ${drawing.id}`);
        const json = serializeDrawing(scene);
        const bytes = Buffer.byteLength(json);
        if (bytes > deps.MAX_IMPORT_ENTRY_BYTES || bytes > deps.MAX_IMPORT_DRAWING_BYTES) {
          return res.status(413).json({ error: "Drawing is too large", message: drawing.name });
        }
        exportedBytes += bytes;
      }
      for (const snapshot of snapshots as any[]) {
        const scene = await prisma.drawingSnapshot.findUnique({
          where: { id: snapshot.id },
          select: { id: true, version: true, elements: true, appState: true, files: true },
        });
        if (!scene) throw new Error(`Snapshot disappeared during export: ${snapshot.id}`);
        const json = serializeSnapshot(scene);
        const bytes = Buffer.byteLength(json);
        if (bytes > deps.MAX_IMPORT_ENTRY_BYTES) {
          return res.status(413).json({ error: "Snapshot is too large", message: snapshot.id });
        }
        exportedBytes += bytes;
      }

      const sceneMemoryLimit = deps.MAX_IMPORT_SCENE_MEMORY_BYTES ?? 64 * 1024 * 1024;
      if (exportedBytes > sceneMemoryLimit) {
        return res.status(413).json({
          error: "Backup is too large",
          message: "Drawing and snapshot data exceed the safe export working-set limit",
        });
      }

      for (const blob of blobsById.values()) {
        if (blob.sizeBytes > deps.MAX_IMPORT_ENTRY_BYTES) {
          return res.status(413).json({ error: "Document is too large", message: blob.id });
        }
        const sourcePath = resolveStoragePath(deps.assetStorageDir, blob.storageKey);
        const stat = await fs.lstat(sourcePath);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error(`Document original is missing: ${blob.id}`);
        exportedBytes += blob.sizeBytes;
      }
      if (exportedBytes > deps.MAX_IMPORT_TOTAL_EXTRACTED_BYTES) {
        return res
          .status(413)
          .json({ error: "Backup is too large", message: "Extracted size limit exceeded" });
      }

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const archive = archiver("zip", { zlib: { level: 6 } });
      const abortArchive = () => {
        try {
          archive.abort();
        } catch {}
      };
      res.on("close", () => {
        if (!res.writableEnded) abortArchive();
      });
      archive.on("error", (error) => {
        logger.error("archive error", { error });
        abortArchive();
        if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
        else res.status(500).json({ error: "Failed to create archive" });
      });
      archive.pipe(res);
      archive.append(manifestJson, { name: "excalidash.manifest.json" });

      const drawingsManifestById = new Map(
        drawingsManifest.map((drawing) => [drawing.id, drawing]),
      );
      for (const drawing of drawings) {
        const meta = drawingsManifestById.get(drawing.id);
        if (!meta) continue;
        assertSafeArchivePath(meta.filePath);
        archive.append(
          Readable.from(
            (async function* () {
              const scene = await prisma.drawing.findUnique({
                where: { id: drawing.id },
                select: {
                  id: true,
                  collectionId: true,
                  elements: true,
                  appState: true,
                  files: true,
                },
              });
              if (!scene) throw new Error(`Drawing disappeared during export: ${drawing.id}`);
              yield serializeDrawing(scene);
            })(),
          ),
          { name: meta.filePath },
        );
      }
      for (const meta of snapshotManifest) {
        assertSafeArchivePath(meta.filePath);
        archive.append(
          Readable.from(
            (async function* () {
              const scene = await prisma.drawingSnapshot.findUnique({
                where: { id: meta.id },
                select: { id: true, version: true, elements: true, appState: true, files: true },
              });
              if (!scene) throw new Error(`Snapshot disappeared during export: ${meta.id}`);
              yield serializeSnapshot(scene);
            })(),
          ),
          { name: meta.filePath },
        );
      }
      for (const meta of blobManifest) {
        assertSafeArchivePath(meta.filePath);
        const blob = blobsById.get(meta.id)!;
        const sourcePath = resolveStoragePath(deps.assetStorageDir, blob.storageKey);
        const source = Readable.from(
          (async function* () {
            let original: NodeJS.ReadableStream = createReadStream(sourcePath);
            if (blob.contentEncoding === "br") original = original.pipe(createBrotliDecompress());
            for await (const chunk of original) yield chunk;
          })(),
        );
        archive.append(source, { name: meta.filePath, store: pdfBlobIds.has(blob.id) });
      }

      archive.append(
        `ExcaliDash Backup (.excalidash)\n\nFormatVersion: 2\nCollections: ${collectionsToExport.length}\nDrawings: ${drawings.length}\nDocuments: ${assetManifest.length}\n`,
        { name: "README.txt" },
      );
      await archive.finalize();
    }),
  );
};
