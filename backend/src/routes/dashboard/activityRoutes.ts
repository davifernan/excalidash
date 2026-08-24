import express from "express";
import { canViewDrawing, getDrawingAccess } from "../../authz/sharing";
import {
  getDrawingVisit,
  listDrawingActivity,
  listTeamActivity,
  recordDrawingVisit,
} from "../../comments/activityFeed";
import type { DrawingRouteContext } from "./drawingRouteContext";

/**
 * The team-wide Activity Feed has its own route (`/activity`), same reason
 * as the Inbox: it is not part of NIL-323's Team Home rebuild in this wave.
 */
export const registerActivityRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const {
    prisma,
    requireAuth,
    optionalAuth,
    asyncHandler,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
  } = context;

  app.get(
    "/activity",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const limit = Number.parseInt(String(req.query.limit ?? "30"), 10) || 30;
      const before = typeof req.query.before === "string" ? req.query.before : null;
      const events = await listTeamActivity({ prisma, viewerUserId: req.user.id, limit, before });
      return res.json({ events });
    }),
  );

  app.get(
    "/drawings/:id/activity",
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
      if (!canViewDrawing(access)) {
        if (respondWithAuthErrorIfPresent(req, res)) return;
        return res.status(404).json({ error: "Drawing not found" });
      }
      const limit = Number.parseInt(String(req.query.limit ?? "30"), 10) || 30;
      const before = typeof req.query.before === "string" ? req.query.before : null;
      const [events, lastVisitedAt] = await Promise.all([
        listDrawingActivity({ prisma, drawingId: id, limit, before }),
        principal?.kind === "user"
          ? getDrawingVisit({ prisma, userId: principal.userId, drawingId: id })
          : null,
      ]);
      return res.json({ events, lastVisitedAt });
    }),
  );

  app.post(
    "/drawings/:id/visit",
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
      await recordDrawingVisit({ prisma, userId: req.user.id, drawingId: id });
      return res.json({ success: true });
    }),
  );
};
