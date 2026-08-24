import express from "express";
import { controlsDrawing } from "../../authz/membership";
import type { DrawingRouteContext } from "./drawingRouteContext";
import { toPublicTrashCollectionId } from "./trash";

/**
 * NIL-365: archive is a reversible lifecycle state, not a rights change and
 * not Trash (`trash.ts`'s per-account staging collection for permanent
 * deletion). Archiving never touches `Drawing.userId`/`collectionId` --
 * only who may see it in the *default* views changes (excluded from Team
 * Home / the plain drawing lists / a name-only search unless explicitly
 * asked for), never who owns it or who is allowed to restore it.
 *
 * Gated the same way "move between collections" already is
 * (`controlsDrawing`, drawingCreateUpdateRoutes.ts's `isOwnerAccess` check
 * for a collection move): only the board's controller may archive or
 * restore it. A collaborator with `edit` can change the drawing but not its
 * lifecycle state, same distinction the codebase already draws between
 * "may edit" and "may share/move".
 */
export const registerArchiveRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const { prisma, requireAuth, asyncHandler, invalidateDrawingsCache } = context;

  app.post(
    "/drawings/:id/archive",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const updated = await prisma.drawing.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      invalidateDrawingsCache();

      return res.json({
        id: updated.id,
        archivedAt: updated.archivedAt,
        collectionId: toPublicTrashCollectionId(updated.collectionId, req.user.id),
      });
    }),
  );

  app.post(
    "/drawings/:id/restore",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const updated = await prisma.drawing.update({
        where: { id },
        data: { archivedAt: null },
      });
      invalidateDrawingsCache();

      return res.json({
        id: updated.id,
        archivedAt: updated.archivedAt,
        collectionId: toPublicTrashCollectionId(updated.collectionId, req.user.id),
      });
    }),
  );
};
