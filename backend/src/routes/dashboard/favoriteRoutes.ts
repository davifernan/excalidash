import express from "express";
import { canViewDrawing, getDrawingAccess } from "../../authz/sharing";
import { setDrawingFavorite } from "../../authz/favorites";
import type { DrawingRouteContext } from "./drawingRouteContext";

/**
 * Starring a board (NIL-292). Gated on `canViewDrawing`, same predicate as
 * `/drawings/:id/visit` -- seeing a board is the whole bar for marking it,
 * same as visiting it leaves a "last opened" marker. Favorite-ness itself
 * lives in `authz/favorites.ts` and rides along on `/drawings` and
 * `/drawings/shared` as `isFavorite`, batched there rather than fetched here.
 */
export const registerFavoriteRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const { prisma, requireAuth, asyncHandler, getRequestPrincipal, invalidateDrawingsCache } =
    context;

  app.put(
    "/drawings/:id/favorite",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal: await getRequestPrincipal(req),
        drawingId: id,
      });
      if (!canViewDrawing(access)) return res.status(404).json({ error: "Drawing not found" });

      await setDrawingFavorite({ prisma, userId: req.user.id, drawingId: id, favorite: true });
      invalidateDrawingsCache();
      return res.json({ isFavorite: true });
    }),
  );

  app.delete(
    "/drawings/:id/favorite",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal: await getRequestPrincipal(req),
        drawingId: id,
      });
      if (!canViewDrawing(access)) return res.status(404).json({ error: "Drawing not found" });

      await setDrawingFavorite({ prisma, userId: req.user.id, drawingId: id, favorite: false });
      invalidateDrawingsCache();
      return res.json({ isFavorite: false });
    }),
  );
};
