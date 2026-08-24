import express from "express";
import {
  canCommentDrawing,
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
} from "../../authz/sharing";
import {
  CommentDomainError,
  createComment,
  deleteComment,
  editComment,
  listComments,
  listMentionCandidates,
  reopenThread,
  resolveThread,
} from "../../comments/commentsDomain";
import type { DrawingRouteContext } from "./drawingRouteContext";

/**
 * Every write route below resolves its principal through
 * `context.getRequestPrincipal(req)`, never `{ kind: "user", userId: req.user.id }`
 * by hand. The bootstrap identity (`req.user.authCredentialType === "bootstrap"`,
 * used when this instance has auth disabled entirely) needs `allowInactive: true`
 * on the principal, because `getDrawingAccess` otherwise looks up a `User` row
 * that does not exist for it and reads back "none" -- every comment write 404ing
 * on an otherwise-working, owner-accessible board. `getRequestPrincipal` already
 * carries this special case (see drawingRouteContext.ts and its three other
 * users: routes/files.ts, assets/assetRoutes.ts, linkPreviews/routes.ts); a
 * hand-built principal silently drops it.
 */
const domainErrorStatus: Record<CommentDomainError["code"], number> = {
  "not-found": 404,
  "not-a-root": 400,
  forbidden: 403,
  "invalid-body": 400,
  "invalid-anchor": 400,
};

const handleDomainError = (res: express.Response, error: unknown): boolean => {
  if (!(error instanceof CommentDomainError)) return false;
  res.status(domainErrorStatus[error.code]).json({ error: error.code, message: error.message });
  return true;
};

export const registerCommentRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const {
    prisma,
    optionalAuth,
    requireAuth,
    asyncHandler,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    io,
  } = context;

  // A recipient may not have the board open at all -- the mention/reply/
  // resolve notification has to reach them wherever they are, not just
  // inside the drawing room. Every authenticated socket joins its own
  // `user_<id>` room on connect (see socket.ts); this is the only writer
  // into that room's events.
  const notifyRecipients = (
    recipients: { userId: string; kind: string }[],
    activityEventId: string,
  ) => {
    for (const recipient of recipients) {
      io.to(`user_${recipient.userId}`).emit("notification-created", {
        activityEventId,
        kind: recipient.kind,
      });
    }
  };

  // Reading comments only requires view access -- the same bar as opening
  // the board at all. Commenting itself is gated separately, per route,
  // below.
  app.get(
    "/drawings/:id/comments",
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
      const includeResolved = req.query.includeResolved === "true";
      const comments = await listComments({ prisma, drawingId: id, includeResolved });
      return res.json({
        comments,
        canComment: canCommentDrawing(access) && principal?.kind === "user",
      });
    }),
  );

  app.get(
    "/drawings/:id/comments/mention-candidates",
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
      const roster = await listMentionCandidates({ prisma, drawingId: id });
      return res.json({
        candidates: roster
          .filter((member) => member.userId !== req.user!.id)
          .map((member) => ({ userId: member.userId, name: member.name })),
      });
    }),
  );

  /**
   * Commenting requires a real, authenticated account (`requireAuth`), not
   * just link access. See docs/product/COMMENTS_GUEST_POLICY.md for why: an
   * anonymous link holder has no identity a mention, a notification or a
   * moderation action could attach to, and unattributable comments are
   * exactly the "comments spiral out of control" failure mode the M3
   * research flagged.
   */
  app.post(
    "/drawings/:id/comments",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal: await getRequestPrincipal(req),
        drawingId: id,
      });
      if (!canCommentDrawing(access)) {
        return res.status(canViewDrawing(access) ? 403 : 404).json({
          error: canViewDrawing(access) ? "Forbidden" : "Drawing not found",
          message: canViewDrawing(access)
            ? "This board does not allow comments from your access level"
            : "Drawing not found",
        });
      }
      try {
        const { comment, activityEventId, recipients } = await createComment({
          prisma,
          drawingId: id,
          authorUserId: req.user.id,
          rawBody: req.body?.body,
          rootId: typeof req.body?.rootId === "string" ? req.body.rootId : null,
          elementId: typeof req.body?.elementId === "string" ? req.body.elementId : null,
          anchorX: req.body?.anchorX,
          anchorY: req.body?.anchorY,
        });
        io.to(`drawing_${id}`).emit("comment-created", comment);
        notifyRecipients(recipients, activityEventId);
        return res.status(201).json({ comment });
      } catch (error) {
        if (handleDomainError(res, error)) return;
        throw error;
      }
    }),
  );

  app.patch(
    "/drawings/:id/comments/:commentId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, commentId } = req.params;
      // Authorship is necessary but not sufficient: a comment written while
      // the account still had comment-level access must not stay editable
      // after that access is revoked (share removed, role changed, offboarded).
      // Without this an ex-member could keep rewriting their old words on a
      // board they can no longer even open.
      const access = await getDrawingAccess({
        prisma,
        principal: await getRequestPrincipal(req),
        drawingId: id,
      });
      if (!canCommentDrawing(access)) {
        return res.status(canViewDrawing(access) ? 403 : 404).json({
          error: canViewDrawing(access) ? "Forbidden" : "Drawing not found",
          message: canViewDrawing(access)
            ? "This board does not allow comments from your access level"
            : "Drawing not found",
        });
      }
      try {
        const { comment, activityEventId, recipients } = await editComment({
          prisma,
          drawingId: id,
          commentId,
          actorUserId: req.user.id,
          rawBody: req.body?.body,
        });
        io.to(`drawing_${id}`).emit("comment-updated", comment);
        if (activityEventId) notifyRecipients(recipients, activityEventId);
        return res.json({ comment });
      } catch (error) {
        if (handleDomainError(res, error)) return;
        throw error;
      }
    }),
  );

  app.delete(
    "/drawings/:id/comments/:commentId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, commentId } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal: await getRequestPrincipal(req),
        drawingId: id,
      });
      // Same reasoning as edit: deleting your own comment still requires
      // currently holding comment-level+ access, not just having held it once.
      // canEditDrawing(access) is strictly stronger than canCommentDrawing(access)
      // (edit/owner both satisfy "comment"), so this one check also covers the
      // moderation path -- an editor with revoked access is "none" here too,
      // and deleteComment below authorizes the moderation branch independently.
      if (!canCommentDrawing(access)) {
        return res.status(canViewDrawing(access) ? 403 : 404).json({
          error: canViewDrawing(access) ? "Forbidden" : "Drawing not found",
          message: canViewDrawing(access)
            ? "This board does not allow comments from your access level"
            : "Drawing not found",
        });
      }
      try {
        await deleteComment({
          prisma,
          drawingId: id,
          commentId,
          actorUserId: req.user.id,
          actorCanModerate: canEditDrawing(access),
        });
        io.to(`drawing_${id}`).emit("comment-deleted", { id: commentId });
        return res.json({ success: true });
      } catch (error) {
        if (handleDomainError(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/comments/:commentId/resolve",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, commentId } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal: await getRequestPrincipal(req),
        drawingId: id,
      });
      if (!canCommentDrawing(access)) {
        return res.status(canViewDrawing(access) ? 403 : 404).json({ error: "Forbidden" });
      }
      try {
        const { comment, activityEventId, recipients } = await resolveThread({
          prisma,
          drawingId: id,
          rootId: commentId,
          actorUserId: req.user.id,
        });
        io.to(`drawing_${id}`).emit("comment-updated", comment);
        if (activityEventId) notifyRecipients(recipients, activityEventId);
        return res.json({ comment });
      } catch (error) {
        if (handleDomainError(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/comments/:commentId/reopen",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, commentId } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal: await getRequestPrincipal(req),
        drawingId: id,
      });
      if (!canCommentDrawing(access)) {
        return res.status(canViewDrawing(access) ? 403 : 404).json({ error: "Forbidden" });
      }
      try {
        const { comment, activityEventId, recipients } = await reopenThread({
          prisma,
          drawingId: id,
          rootId: commentId,
          actorUserId: req.user.id,
        });
        io.to(`drawing_${id}`).emit("comment-updated", comment);
        if (activityEventId) notifyRecipients(recipients, activityEventId);
        return res.json({ comment });
      } catch (error) {
        if (handleDomainError(res, error)) return;
        throw error;
      }
    }),
  );
};
