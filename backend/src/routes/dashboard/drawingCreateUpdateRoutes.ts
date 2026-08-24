import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Prisma } from "../../generated/client";
import { logger } from "../../logger";
import { canEditDrawing, getDrawingAccess, isOwnerAccess } from "../../authz/sharing";
import { rewritePreviewFileReferences } from "../../fileProcessing";
import {
  getUserTrashCollectionId,
  isTrashCollectionId,
  toInternalTrashCollectionId,
  toPublicTrashCollectionId,
} from "./trash";
import { encodeSnapshotField } from "../../snapshots/snapshotCodec";
import { captureSnapshotAssets } from "../../assets/assetService";
import {
  InvalidDocumentWidgetStateError,
  syncDrawingDocumentState,
} from "../../assets/documentWidgetState";
import type { DrawingRouteContext } from "./drawingRouteContext";
import { pruneDrawingSnapshots } from "../../snapshots/snapshotRetention";
import { publishDrawingName } from "../../server/socketDrawingName";
import { getCollectionShareLevel, getOwnedCollection } from "../../authz/collections";
import { isCollectionCreator } from "../../authz/boards";
import { computeSearchText } from "../../search/searchIndex";

export const registerDrawingCreateUpdateRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    requireAuth,
    optionalAuth,
    asyncHandler,
    validateImportedDrawing,
    drawingCreateSchema,
    drawingUpdateSchema,
    respondWithValidationErrors,
    ensureTrashCollection,
    invalidateDrawingsCache,
    config,
    processEmbeddedImages,
    parseJsonField,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    collaborationAccess,
    io,
  } = context;
  app.post(
    "/drawings",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const isImportedDrawing = req.headers["x-imported-file"] === "true";
      if (isImportedDrawing && !validateImportedDrawing(req.body)) {
        return res.status(400).json({
          error: "Invalid imported drawing file",
          message: "The imported file contains potentially malicious content or invalid structure",
        });
      }

      const parsed = drawingCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const payload = parsed.data as {
        name?: string;
        collectionId?: string | null;
        elements: unknown[];
        appState: Record<string, unknown>;
        preview?: string | null;
        files?: Record<string, unknown>;
      };
      const drawingName = payload.name ?? "Untitled Drawing";
      const targetCollectionIdRaw =
        payload.collectionId === undefined ? null : payload.collectionId;
      const targetCollectionId =
        toInternalTrashCollectionId(targetCollectionIdRaw, req.user.id) ?? null;

      // A board drawn inside someone else's collection belongs to that
      // collection, not to the hand that drew it. Otherwise the person who owns
      // the team folder cannot share, move or clean up what is in it, and the
      // board silently leaves the team the day its author does.
      let ownerUserId = req.user.id;
      if (targetCollectionId && !isTrashCollectionId(targetCollectionId, req.user.id)) {
        const collection = await prisma.collection.findFirst({
          where: { id: targetCollectionId },
        });
        if (!collection) return res.status(404).json({ error: "Collection not found" });

        // If the collection belongs to someone else, check the user has editor access.
        // Asked as a level rather than matched against the string "edit": a
        // hand-written match reads a "comment" grant as no grant at all, which
        // is right today only because nothing issues one yet.
        if (!isCollectionCreator(collection, req.user.id)) {
          const level = await getCollectionShareLevel({
            db: prisma,
            userId: req.user.id,
            collectionId: targetCollectionId,
          });
          if (!level || !canEditDrawing(level)) {
            return res.status(403).json({ error: "No edit access to this collection" });
          }
          ownerUserId = collection.userId;
        }
      } else if (targetCollectionIdRaw === "trash") {
        await ensureTrashCollection(prisma, req.user.id);
      }

      const newDrawingId = uuidv4();
      const originalFiles = payload.files ?? {};
      const processedFiles = await processEmbeddedImages(originalFiles, ownerUserId, newDrawingId);
      const processedPreview = rewritePreviewFileReferences(
        payload.preview ?? null,
        originalFiles,
        processedFiles,
      );

      const newDrawing = await prisma.drawing.create({
        data: {
          id: newDrawingId,
          name: drawingName,
          elements: JSON.stringify(payload.elements),
          appState: JSON.stringify(payload.appState),
          userId: ownerUserId,
          createdByUserId: req.user.id,
          collectionId: targetCollectionId,
          preview: typeof processedPreview === "string" ? processedPreview : null,
          files: JSON.stringify(processedFiles),
          searchText: computeSearchText(drawingName, payload.elements),
        },
      });
      invalidateDrawingsCache();

      return res.json({
        ...newDrawing,
        collectionId: toPublicTrashCollectionId(newDrawing.collectionId, req.user.id),
        elements: parseJsonField(newDrawing.elements, []),
        appState: parseJsonField(newDrawing.appState, {}),
        files: parseJsonField(newDrawing.files, {}),
      });
    }),
  );

  app.put(
    "/drawings/:id",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const principal = await getRequestPrincipal(req);

      const { id } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal,
        drawingId: id,
        shareToken: getShareToken(req),
      });
      if (!canEditDrawing(access)) {
        if (respondWithAuthErrorIfPresent(req, res)) return;
        return res.status(404).json({
          error: "Drawing not found",
          message: "Drawing does not exist",
        });
      }

      const existingDrawing = await prisma.drawing.findUnique({
        where: { id },
      });
      if (!existingDrawing) return res.status(404).json({ error: "Drawing not found" });

      const parsed = drawingUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        if (config.nodeEnv === "development") {
          logger.error("validation failed", {
            id,
            errors: parsed.error.issues,
          });
        }
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const payload = parsed.data as {
        name?: string;
        collectionId?: string | null;
        elements?: unknown[];
        appState?: Record<string, unknown>;
        preview?: string | null;
        files?: Record<string, unknown>;
        version?: number;
      };
      const ownerUserId = existingDrawing.userId;
      const trashCollectionId = getUserTrashCollectionId(ownerUserId);
      const isSceneUpdate =
        payload.elements !== undefined ||
        payload.appState !== undefined ||
        payload.files !== undefined;

      if (isSceneUpdate && payload.version === undefined) {
        return res.status(409).json({
          error: "Conflict",
          code: "VERSION_REQUIRED",
          message: "Scene updates require the current drawing version.",
          currentVersion: existingDrawing.version,
        });
      }

      if (isSceneUpdate && payload.version !== existingDrawing.version) {
        return res.status(409).json({
          error: "Conflict",
          code: "VERSION_CONFLICT",
          message: "Drawing has changed since this editor state was loaded.",
          currentVersion: existingDrawing.version,
        });
      }
      const data: Prisma.DrawingUpdateInput = isSceneUpdate ? { version: { increment: 1 } } : {};

      if (payload.name !== undefined) {
        data.name = payload.name;
        data.nameRevision = { increment: 1 };
      }
      if (payload.elements !== undefined) data.elements = JSON.stringify(payload.elements);
      if (payload.appState !== undefined) data.appState = JSON.stringify(payload.appState);
      if (payload.name !== undefined || payload.elements !== undefined) {
        data.searchText = computeSearchText(
          payload.name ?? existingDrawing.name,
          payload.elements ?? parseJsonField(existingDrawing.elements, []),
        );
      }
      let processedFilesForUpdate: Record<string, unknown> | undefined;
      if (payload.files !== undefined) {
        // Union, not replace (NIL-381/NIL-377): a save's `files` payload is
        // whatever the client's own scene currently references, not a claim
        // about every file this board has ever had. Replacing outright loses
        // a file a different tab/session already stored the moment this
        // save's payload does not happen to repeat it -- the half of
        // NIL-377 this repo was missing. An incoming entry only overwrites
        // an existing one when it actually carries content; a null/empty
        // entry is not a deletion request here (that is what the dedicated
        // files/orphans endpoint is for), so it must not blank out a
        // survivor.
        const existingFiles = parseJsonField(existingDrawing.files, {}) as Record<string, unknown>;
        const isNonEmptyFileEntry = (entry: unknown): boolean =>
          typeof entry === "object" && entry !== null && Object.keys(entry).length > 0;
        const mergedFiles: Record<string, unknown> = { ...existingFiles };
        for (const [fileId, entry] of Object.entries(payload.files)) {
          if (isNonEmptyFileEntry(entry)) mergedFiles[fileId] = entry;
        }

        processedFilesForUpdate = await processEmbeddedImages(mergedFiles, ownerUserId, id);
        data.files = JSON.stringify(processedFilesForUpdate);
      }
      if (payload.preview !== undefined) {
        const processedPreview = processedFilesForUpdate
          ? rewritePreviewFileReferences(
              payload.preview,
              payload.files ?? {},
              processedFilesForUpdate,
            )
          : payload.preview;
        data.preview = typeof processedPreview === "string" ? processedPreview : null;
      }

      if (payload.collectionId !== undefined) {
        if (!isOwnerAccess(access)) {
          return res.status(403).json({
            error: "Forbidden",
            message: "Only the owner can move drawings between collections",
          });
        }
        if (payload.collectionId === "trash") {
          await ensureTrashCollection(prisma, ownerUserId);
          (data as Prisma.DrawingUncheckedUpdateInput).collectionId = trashCollectionId;
        } else if (payload.collectionId) {
          const collection = await getOwnedCollection({
            db: prisma,
            userId: ownerUserId,
            collectionId: payload.collectionId,
          });
          if (!collection) return res.status(404).json({ error: "Collection not found" });
          (data as Prisma.DrawingUncheckedUpdateInput).collectionId = payload.collectionId;
        } else {
          (data as Prisma.DrawingUncheckedUpdateInput).collectionId = null;
        }
      }

      const updateWhere: Prisma.DrawingWhereInput = { id };
      if (isSceneUpdate) {
        updateWhere.version = payload.version;
      }

      const versionConflictError = new Error("VERSION_CONFLICT");
      let updatedDrawing: typeof existingDrawing | null = null;

      try {
        if (isSceneUpdate) {
          // Prisma's 5s default interactive-transaction timeout: this
          // transaction snapshots and rewrites the whole scene, files
          // included, and SQLite is a single writer -- several
          // near-simultaneous large-image saves (NIL-330's integrated
          // acceptance run reproduced it with three overlapping ~15-40MB
          // PUTs) queue on the writer lock long enough to expire it,
          // failing an otherwise-legitimate save with a 500 rather than a
          // client-caused conflict.
          updatedDrawing = await prisma.$transaction(
            async (tx) => {
              const compress = config.enableSnapshotCompression;
              const snapshot = await tx.drawingSnapshot.create({
                data: {
                  drawingId: id,
                  version: existingDrawing.version,
                  elements: encodeSnapshotField(existingDrawing.elements, compress),
                  appState: encodeSnapshotField(existingDrawing.appState, compress),
                  files: encodeSnapshotField(existingDrawing.files, compress),
                },
              });

              const updateResult = await tx.drawing.updateMany({
                where: updateWhere,
                data,
              });
              if (updateResult.count === 0) {
                throw versionConflictError;
              }

              // The version being replaced keeps whatever documents it used, so
              // restoring it later still finds them.
              await captureSnapshotAssets(tx, snapshot.id, id);

              // And the board now claims exactly the documents its elements name.
              // Inside the transaction, so a board and its document list can
              // never disagree; ids this board never had are refused rather than
              // ignored, because a client naming someone else's document is not
              // a mistake to paper over.
              if (payload.elements !== undefined) {
                await syncDrawingDocumentState(tx, id, payload.elements);
              }

              await pruneDrawingSnapshots(tx, id, config.snapshotMaxCountPerDrawing);

              return tx.drawing.findFirst({ where: { id } });
            },
            { timeout: 15_000 },
          );
        } else {
          const updateResult = await prisma.drawing.updateMany({
            where: updateWhere,
            data,
          });
          if (updateResult.count === 0) {
            return res.status(404).json({ error: "Drawing not found" });
          }
          updatedDrawing = await prisma.drawing.findFirst({
            where: { id },
          });
        }
      } catch (error) {
        if (error instanceof InvalidDocumentWidgetStateError) {
          return res.status(400).json({
            error: "Invalid document widgets",
            code: error.code,
            message: error.message,
          });
        }
        if (
          error === versionConflictError ||
          (error instanceof Error && error.message === versionConflictError.message)
        ) {
          const latestDrawing = await prisma.drawing.findFirst({
            where: { id },
            select: { version: true },
          });
          return res.status(409).json({
            error: "Conflict",
            code: "VERSION_CONFLICT",
            message: "Drawing has changed since this editor state was loaded.",
            currentVersion: latestDrawing?.version ?? null,
          });
        }
        throw error;
      }
      if (!updatedDrawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      invalidateDrawingsCache();
      // Moving a board out of a shared collection revokes everyone who reached it
      // that way. HTTP notices immediately; a socket that is only listening would
      // otherwise keep receiving the board until the periodic sweep caught up.
      if (payload.collectionId !== undefined) {
        await collaborationAccess.recheckDrawingAccess(id);
      }
      if (payload.name !== undefined) {
        publishDrawingName({
          io,
          drawingId: id,
          name: updatedDrawing.name,
          revision: updatedDrawing.nameRevision,
        });
      }

      return res.json({
        ...updatedDrawing,
        collectionId: toPublicTrashCollectionId(updatedDrawing.collectionId, ownerUserId),
        elements: parseJsonField(updatedDrawing.elements, []),
        appState: parseJsonField(updatedDrawing.appState, {}),
        files: parseJsonField(updatedDrawing.files, {}),
        accessLevel: access,
      });
    }),
  );
};
