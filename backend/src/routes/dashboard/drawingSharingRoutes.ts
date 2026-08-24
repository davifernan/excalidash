import express from "express";
import { normalizeDrawingPermission } from "../../authz/sharing";
import { controlsDrawing } from "../../authz/membership";
import { getDrawingRosters } from "../../authz/roster";
import type { DrawingRouteContext } from "./drawingRouteContext";
import {
  grantDrawingPermission,
  issueDrawingLinkShare,
  listDrawingLinkShares,
  listDrawingPermissions,
  revokeDrawingLinkShare,
  revokeDrawingPermission,
} from "../../authz/grants";

export const registerDrawingSharingRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    invalidateDrawingsCache,
    collaborationAccess,
    config,
    logAuditEvent,
    resolveDefaultTtlMs,
    resolveMaxTtlMs,
  } = context;
  // Owner-only: resolve users by name/email in the context of a drawing you own (reduces enumeration risk).
  app.get(
    "/drawings/:id/share-resolve",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const q = qRaw.toLowerCase();
      if (q.length < 3) return res.json({ users: [] });

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const users = await prisma.user.findMany({
        where: {
          isActive: true,
          id: { not: req.user.id },
          OR: [
            { email: { contains: q } },
            { name: { contains: q } },
            { username: { contains: q } },
          ],
        },
        select: { id: true, name: true, email: true },
        take: 10,
      });

      return res.json({ users });
    }),
  );

  app.get(
    "/drawings/:id/sharing",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const [permissions, linkShares, rosters] = await Promise.all([
        listDrawingPermissions({ db: prisma, drawingId: id }),
        listDrawingLinkShares({ db: prisma, drawingId: id }),
        // NIL-291: `permissions` above is direct grants only, which is why
        // the Share dialog previously had no way to show that someone with
        // no direct grant still has access -- through the collection this
        // board lives in. `getDrawingRosters` (authz/roster.ts) already
        // computes the full claim, direct-or-inherited, with a `via` label;
        // reusing it here is the fix, not a new rights computation.
        getDrawingRosters({ prisma, drawingIds: [id] }),
      ]);

      return res.json({ permissions, linkShares, roster: rosters.get(id) ?? [] });
    }),
  );

  app.post(
    "/drawings/:id/permissions",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const granteeUserId =
        typeof req.body?.granteeUserId === "string" ? req.body.granteeUserId : null;
      const permission = normalizeDrawingPermission(req.body?.permission);
      if (!granteeUserId || !permission) {
        return res.status(400).json({
          error: "Validation error",
          message: "Invalid grantee or permission",
        });
      }
      if (granteeUserId === req.user.id) {
        return res.status(400).json({
          error: "Validation error",
          message: "Cannot share with yourself",
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: granteeUserId },
        select: { id: true, isActive: true },
      });
      if (!user || !user.isActive) {
        return res.status(404).json({ error: "User not found" });
      }

      const saved = await grantDrawingPermission({
        db: prisma,
        drawingId: id,
        granteeUserId,
        permission,
        grantedByUserId: req.user.id,
      });

      invalidateDrawingsCache();

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_shared_user_upsert",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: id, granteeUserId, permission },
        });
      }

      return res.json({ permission: saved });
    }),
  );

  app.delete(
    "/drawings/:id/permissions/:permId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, permId } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const { revoked, granteeUserId: revokedFrom } = await revokeDrawingPermission({
        db: prisma,
        drawingId: id,
        permissionId: permId,
      });
      invalidateDrawingsCache();
      if (revoked && revokedFrom) {
        await collaborationAccess.recheckDrawingAccess(id, revokedFrom);
      }

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_shared_user_revoke",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: id, permissionId: permId },
        });
      }

      return res.json({ success: true });
    }),
  );

  app.post(
    "/drawings/:id/link-shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const permission = normalizeDrawingPermission(req.body?.permission);
      if (!permission) {
        return res.status(400).json({ error: "Validation error", message: "Invalid permission" });
      }

      const now = Date.now();
      const maxTtlMs = resolveMaxTtlMs();
      const defaultTtlMs = resolveDefaultTtlMs(permission);
      const effectiveDefaultTtlMs =
        permission === "edit" ? Math.min(defaultTtlMs, maxTtlMs) : defaultTtlMs;
      const hasExpiresAtKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "expiresAt");
      const rawExpiresAt = req.body?.expiresAt;

      let expiresAt: Date | null;
      if (hasExpiresAtKey && rawExpiresAt === null) {
        // Only "edit" is forced to expire. This line predates NIL-487's
        // "comment" level and had not been re-audited for it: matched
        // against "edit" rather than "view", it groups comment with edit
        // here while resolveDefaultTtlMs (above) deliberately groups comment
        // with view for the *duration* of that expiry. A leaked comment
        // link cannot destroy work any more than a view link can, so the
        // eternal-link allowance follows the same grouping here.
        expiresAt = permission === "edit" ? new Date(now + effectiveDefaultTtlMs) : null;
      } else {
        const requestedExpiresAt =
          typeof rawExpiresAt === "string" && rawExpiresAt.trim().length > 0
            ? new Date(rawExpiresAt.trim())
            : null;
        const hasValidRequestedExpiry = Boolean(
          requestedExpiresAt && Number.isFinite(requestedExpiresAt.getTime()),
        );

        if (hasValidRequestedExpiry && requestedExpiresAt) {
          const candidateTtlMs = requestedExpiresAt.getTime() - now;
          if (candidateTtlMs < 60_000) {
            return res.status(400).json({
              error: "Validation error",
              message: "Expiry must be at least 1 minute in the future",
            });
          }
          const ttlMs = permission === "edit" ? Math.min(candidateTtlMs, maxTtlMs) : candidateTtlMs;
          expiresAt = new Date(now + ttlMs);
        } else if (hasExpiresAtKey && rawExpiresAt !== undefined && rawExpiresAt !== null) {
          return res.status(400).json({
            error: "Validation error",
            message: "Invalid expiry",
          });
        } else {
          expiresAt = new Date(now + effectiveDefaultTtlMs);
        }
      }

      // A new activation always revokes the previous secret, in one
      // transaction. This makes a reissued link independent from every URL
      // that was shared before it, and leaves no window in which two secrets
      // are live at once.
      const { token, share: created } = await prisma.$transaction((tx) =>
        issueDrawingLinkShare({
          db: tx,
          drawingId: id,
          permission,
          expiresAt,
          createdByUserId: req.user!.id,
        }),
      );
      await collaborationAccess.recheckDrawingAccess(id);
      // NIL-290: /drawings now reports whether a board has an active link
      // share (linkShared), so a change here is no longer invisible to that
      // cache -- same invalidation every other mutation in this file already
      // does.
      invalidateDrawingsCache();

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_link_share_created",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: {
            drawingId: id,
            permission,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
          },
        });
      }

      return res.json({ share: created, token });
    }),
  );

  app.delete(
    "/drawings/:id/link-shares/:shareId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, shareId } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const revoked = await revokeDrawingLinkShare({ db: prisma, drawingId: id, shareId });
      if (revoked) {
        await collaborationAccess.recheckDrawingAccess(id);
        invalidateDrawingsCache();
      }

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_link_share_revoked",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: id, shareId },
        });
      }

      return res.json({ success: true });
    }),
  );
};
