import express from "express";
import { canEditDrawing, getDrawingAccess } from "../../authz/sharing";
import { decodeSnapshotField, encodeSnapshotField } from "../../snapshots/snapshotCodec";
import { captureSnapshotAssets } from "../../assets/assetService";
import { referencedAssetIds, syncDrawingDocumentState } from "../../assets/documentWidgetState";
import { pruneDrawingSnapshots } from "../../snapshots/snapshotRetention";
import type { DrawingRouteContext } from "./drawingRouteContext";

export const registerDrawingHistoryRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    optionalAuth,
    asyncHandler,
    config,
    parseJsonField,
    invalidateDrawingsCache,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    io,
  } = context;
  // ============================================================
  // Drawing Version History
  // ============================================================

  // List snapshots (metadata only)
  app.get(
    "/drawings/:id/history",
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
        return res.status(404).json({ error: "Drawing not found" });
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const [snapshots, totalCount] = await Promise.all([
        prisma.drawingSnapshot.findMany({
          where: { drawingId: id },
          select: { id: true, version: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.drawingSnapshot.count({ where: { drawingId: id } }),
      ]);

      return res.json({ snapshots, totalCount });
    }),
  );

  // Get full snapshot for preview
  app.get(
    "/drawings/:id/history/:snapshotId",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const principal = await getRequestPrincipal(req);
      const { id, snapshotId } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal,
        drawingId: id,
        shareToken: getShareToken(req),
      });
      if (!canEditDrawing(access)) {
        if (respondWithAuthErrorIfPresent(req, res)) return;
        return res.status(404).json({ error: "Drawing not found" });
      }

      const snapshot = await prisma.drawingSnapshot.findFirst({
        where: { id: snapshotId, drawingId: id },
      });
      if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });

      return res.json({
        ...snapshot,
        elements: parseJsonField(decodeSnapshotField(snapshot.elements), []),
        appState: parseJsonField(decodeSnapshotField(snapshot.appState), {}),
        files: parseJsonField(decodeSnapshotField(snapshot.files), {}),
      });
    }),
  );

  // Restore a snapshot (snapshots current state first, then applies old state)
  app.post(
    "/drawings/:id/history/:snapshotId/restore",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const principal = await getRequestPrincipal(req);
      const { id, snapshotId } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal,
        drawingId: id,
        shareToken: getShareToken(req),
      });
      if (!canEditDrawing(access)) {
        if (respondWithAuthErrorIfPresent(req, res)) return;
        return res.status(404).json({ error: "Drawing not found" });
      }

      const [drawing, snapshot] = await Promise.all([
        prisma.drawing.findUnique({ where: { id } }),
        prisma.drawingSnapshot.findFirst({
          where: { id: snapshotId, drawingId: id },
        }),
      ]);
      if (!drawing) return res.status(404).json({ error: "Drawing not found" });
      if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });

      const restoredElements = decodeSnapshotField(snapshot.elements);
      const restoredAppState = decodeSnapshotField(snapshot.appState);
      const restoredFiles = decodeSnapshotField(snapshot.files);
      const wantedAssetIds = referencedAssetIds(parseJsonField(restoredElements, []));

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.drawing.findUnique({ where: { id } });
        if (!current) throw new Error("Drawing disappeared during restore");
        // Snapshot current state before restoring (so restore is reversible),
        // including the documents that make that state usable.
        const backup = await tx.drawingSnapshot.create({
          data: {
            drawingId: id,
            version: current.version,
            elements: encodeSnapshotField(current.elements, config.enableSnapshotCompression),
            appState: encodeSnapshotField(current.appState, config.enableSnapshotCompression),
            files: encodeSnapshotField(current.files, config.enableSnapshotCompression),
          },
        });
        await captureSnapshotAssets(tx, backup.id, id);

        // A document removed from the current board remains reachable through
        // the historical snapshot. Reattach those links before the ordinary
        // reconciliation validates the restored element ids.
        const archivedAssets = await tx.drawingSnapshotAsset.findMany({
          where: { snapshotId },
          select: { assetId: true },
        });
        const archivedAssetIds = new Set(archivedAssets.map((row: any) => row.assetId));
        const missing = wantedAssetIds.filter((assetId) => !archivedAssetIds.has(assetId));
        if (missing.length > 0) {
          throw new Error("Snapshot document references are incomplete");
        }
        for (const assetId of wantedAssetIds) {
          await tx.drawingAsset.upsert({
            where: { drawingId_assetId: { drawingId: id, assetId } },
            create: { drawingId: id, assetId, state: "ACTIVE", expiresAt: null },
            update: { state: "ACTIVE", expiresAt: null },
          });
        }
        await syncDrawingDocumentState(tx, id, parseJsonField(restoredElements, []));

        const restored = await tx.drawing.update({
          where: { id },
          data: {
            // Drawing rows are always plain JSON — decode before restoring.
            elements: restoredElements,
            appState: restoredAppState,
            files: restoredFiles,
            version: { increment: 1 },
          },
        });
        await pruneDrawingSnapshots(tx, id, config.snapshotMaxCountPerDrawing);
        return restored;
      });

      invalidateDrawingsCache();
      io.to(`drawing_${id}`).emit("drawing-server-update", { drawingId: id });

      return res.json({
        ...updated,
        elements: parseJsonField(updated.elements, []),
        appState: parseJsonField(updated.appState, {}),
        files: parseJsonField(updated.files, {}),
        accessLevel: access,
      });
    }),
  );
};
