import express from "express";
import { v4 as uuidv4 } from "uuid";
import { rewritePreviewFileReferences } from "../../fileProcessing";
import { getUserTrashCollectionId, isTrashCollectionId, toPublicTrashCollectionId } from "./trash";
import type { DrawingRouteContext } from "./drawingRouteContext";
import { deleteOwnedBoard, getOwnedBoard } from "../../authz/boards";
import { computeSearchText } from "../../search/searchIndex";

export const registerDrawingDeleteDuplicateRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    ensureTrashCollection,
    invalidateDrawingsCache,
    config,
    logAuditEvent,
    parseJsonField,
    cleanupS3FilesForDrawing,
    cloneS3FileReferences,
    cloneDrawingFileReferences,
    collaborationAccess,
  } = context;
  app.delete(
    "/drawings/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      const drawing = await getOwnedBoard({ db: prisma, userId: req.user.id, boardId: id });
      if (!drawing) return res.status(404).json({ error: "Drawing not found" });

      const deletedCount = await deleteOwnedBoard({ db: prisma, userId: req.user.id, boardId: id });
      if (deletedCount === 0) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      await collaborationAccess.recheckDrawingAccess(id);
      try {
        await cleanupS3FilesForDrawing(id, req.user.id);
      } catch (error) {
        console.warn("[s3] Failed to cleanup deleted drawing files", { drawingId: id, error });
      }
      invalidateDrawingsCache();

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_deleted",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: id, drawingName: drawing.name },
        });
      }

      return res.json({ success: true });
    }),
  );

  app.post(
    "/drawings/:id/duplicate",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      const original = await getOwnedBoard({ db: prisma, userId: req.user.id, boardId: id });
      if (!original) return res.status(404).json({ error: "Original drawing not found" });
      let duplicatedCollectionId = original.collectionId;
      if (isTrashCollectionId(original.collectionId, req.user.id)) {
        await ensureTrashCollection(prisma, req.user.id);
        duplicatedCollectionId = getUserTrashCollectionId(req.user.id);
      }

      const newDrawingId = uuidv4();
      const originalFiles = parseJsonField<Record<string, any>>(original.files, {});
      const duplicatedName = `${original.name} (Copy)`;

      // The target row must exist before any DrawingFile clone: unlike
      // S3File (a plain drawingId string column), DrawingFile has a real
      // foreign key to Drawing, so a reference row for newDrawingId written
      // before this insert would fail its constraint. Cloning starts with
      // the original's own files/preview and is corrected below once the
      // clones are known -- S3File carried no such constraint and could
      // clone first, which is why this create used to run last.
      let newDrawing = await prisma.drawing.create({
        data: {
          id: newDrawingId,
          name: duplicatedName,
          elements: original.elements,
          appState: original.appState,
          files: original.files,
          preview: original.preview,
          userId: original.userId,
          createdByUserId: req.user.id,
          collectionId: duplicatedCollectionId,
          version: 1,
          // Archive is a lifecycle state of the original board, not something
          // a copy inherits -- a duplicate always starts active, same as a
          // brand-new board would.
          searchText: computeSearchText(duplicatedName, parseJsonField(original.elements, [])),
        },
      });

      const filesWithS3Clones = await cloneS3FileReferences(
        original.id,
        newDrawingId,
        req.user.id,
        originalFiles,
      );
      // The duplicate keeps the original's owner (`userId: original.userId`
      // above), so DrawingFile rows for it are charged to that same owner --
      // matching how storeDrawingFile always charges the board owner, not
      // whoever's request triggered the write.
      const duplicatedFiles = await cloneDrawingFileReferences(
        original.id,
        newDrawingId,
        original.userId,
        filesWithS3Clones,
      );
      const duplicatedPreview = rewritePreviewFileReferences(
        original.preview ?? null,
        originalFiles,
        duplicatedFiles,
      );

      if (duplicatedFiles !== originalFiles || duplicatedPreview !== original.preview) {
        newDrawing = await prisma.drawing.update({
          where: { id: newDrawingId },
          data: {
            files: JSON.stringify(duplicatedFiles),
            preview: typeof duplicatedPreview === "string" ? duplicatedPreview : original.preview,
          },
        });
      }
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
};
