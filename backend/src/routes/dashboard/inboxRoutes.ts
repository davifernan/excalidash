import express from "express";
import {
  getTeamActivityVisit,
  listInbox,
  markAllNotificationsRead,
  markNotificationRead,
  recordTeamActivityVisit,
  unreadNotificationCount,
} from "../../comments/activityFeed";
import type { DrawingRouteContext } from "./drawingRouteContext";

/**
 * The Inbox has its own top-level route (`/inbox`) and its own editor
 * sidebar entry point -- it is deliberately not woven into
 * pages/Dashboard.tsx or components/Layout.tsx, which NIL-323 is rebuilding
 * in this same wave. See the NIL-324 package CLAIM for why.
 */
export const registerInboxRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const { prisma, requireAuth, asyncHandler } = context;

  app.get(
    "/inbox",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const unreadOnly = req.query.unreadOnly === "true";
      const limit = Number.parseInt(String(req.query.limit ?? "30"), 10) || 30;
      const before = typeof req.query.before === "string" ? req.query.before : null;
      const [notifications, unreadCount, lastSeenAt] = await Promise.all([
        listInbox({ prisma, userId: req.user.id, unreadOnly, limit, before }),
        unreadNotificationCount({ prisma, userId: req.user.id }),
        getTeamActivityVisit({ prisma, userId: req.user.id }),
      ]);
      return res.json({ notifications, unreadCount, lastSeenAt });
    }),
  );

  app.post(
    "/inbox/:notificationId/read",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const ok = await markNotificationRead({
        prisma,
        userId: req.user.id,
        notificationId: req.params.notificationId,
      });
      if (!ok) return res.status(404).json({ error: "Notification not found" });
      return res.json({ success: true });
    }),
  );

  app.post(
    "/inbox/read-all",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      await markAllNotificationsRead({ prisma, userId: req.user.id });
      return res.json({ success: true });
    }),
  );

  // "Seen the team feed" -- a distinct marker from "read this notification".
  // Visiting /activity clears the team-feed unseen dot even for events that
  // never produced a personal notification (nobody mentioned you, but a
  // board you belong to had activity).
  app.post(
    "/inbox/visit-activity",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      await recordTeamActivityVisit({ prisma, userId: req.user.id });
      return res.json({ success: true });
    }),
  );
};
