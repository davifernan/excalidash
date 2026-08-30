import express from "express";
import { z } from "zod";
import {
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
  type DrawingAccess,
} from "../../authz/sharing";
import {
  OrchestratorThreadError,
  appendOrchestratorThreadMessage,
  getOrCreatePrivateOrchestratorThread,
  getVisibleOrchestratorThread,
  listOrchestratorThreadEvents,
  listVisibleOrchestratorThreads,
  movePrivateOrchestratorThread,
  registerDrawingOrchestratorThread,
} from "../../agent/orchestratorThreads";
import {
  publishBoardAgentThreadEvent,
  publishBoardAgentThreadUpdated,
} from "../../server/socketAgentThreads";
import type { DrawingRouteContext } from "./drawingRouteContext";

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const anchorSchema = z.object({ x: coordinate, y: coordinate });
const sharedSchema = z.object({ anchorElementId: z.string().min(1).max(200) });
const messageSchema = z.object({ text: z.string().trim().min(1).max(10_000) });

const handleThreadError = (res: express.Response, error: unknown): boolean => {
  if (!(error instanceof OrchestratorThreadError)) return false;
  const status = error.code === "THREAD_INVALID" ? 400 : 404;
  res.status(status).json({ error: error.code, message: error.message });
  return true;
};

/**
 * Local and shared threads share one API family and event domain, but no route
 * can change an existing thread's audience. The only audience-selecting calls
 * create a fresh server row through their audience-specific invariant.
 */
export const registerDrawingOrchestratorThreadRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    optionalAuth,
    requireAuth,
    asyncHandler,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    io,
    presences,
  } = context;

  const loadAccess = async (
    req: express.Request,
    res: express.Response,
  ): Promise<DrawingAccess | null> => {
    const access = await getDrawingAccess({
      prisma,
      principal: await getRequestPrincipal(req),
      drawingId: req.params.id,
      shareToken: getShareToken(req),
    });
    if (!canViewDrawing(access)) {
      if (respondWithAuthErrorIfPresent(req, res)) return null;
      res.status(404).json({ error: "Drawing not found" });
      return null;
    }
    return access;
  };

  const accountId = (req: express.Request): string | null =>
    req.user?.authCredentialType !== "apiKey" ? (req.user?.id ?? null) : null;

  app.get(
    "/drawings/:id/orchestrator-threads",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      return res.json({
        threads: await listVisibleOrchestratorThreads({
          prisma,
          drawingId: req.params.id,
          userId: accountId(req),
        }),
      });
    }),
  );

  app.post(
    "/drawings/:id/orchestrator-threads/local",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      const userId = accountId(req);
      if (!userId) return res.status(401).json({ error: "Account sign-in required" });
      const parsed = anchorSchema.safeParse(req.body?.anchor);
      if (!parsed.success) return res.status(400).json({ error: "Invalid private anchor" });
      try {
        const thread = await getOrCreatePrivateOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          userId,
          initialAnchor: parsed.data,
        });
        publishBoardAgentThreadUpdated({ io, presences, thread });
        return res.status(201).json({ thread });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/orchestrator-threads/shared",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const access = await loadAccess(req, res);
      if (!access) return;
      if (!canEditDrawing(access)) return res.status(403).json({ error: "Edit access required" });
      const parsed = sharedSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid shared anchor" });
      try {
        const thread = await registerDrawingOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          anchorElementId: parsed.data.anchorElementId,
        });
        publishBoardAgentThreadUpdated({ io, presences, thread });
        return res.status(201).json({ thread });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.patch(
    "/drawings/:id/orchestrator-threads/:threadId/local-anchor",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      const userId = accountId(req);
      if (!userId) return res.status(401).json({ error: "Account sign-in required" });
      const parsed = anchorSchema.safeParse(req.body?.anchor);
      if (!parsed.success) return res.status(400).json({ error: "Invalid private anchor" });
      try {
        const thread = await movePrivateOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          threadId: req.params.threadId,
          userId,
          anchor: parsed.data,
        });
        publishBoardAgentThreadUpdated({ io, presences, thread });
        return res.json({ thread });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.get(
    "/drawings/:id/orchestrator-threads/:threadId/events",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      try {
        const afterSequence = Number(req.query.afterSequence ?? 0);
        return res.json({
          events: await listOrchestratorThreadEvents({
            prisma,
            drawingId: req.params.id,
            threadId: req.params.threadId,
            userId: accountId(req),
            afterSequence: Number.isSafeInteger(afterSequence) ? afterSequence : 0,
          }),
        });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/orchestrator-threads/:threadId/events",
    requireAuth,
    asyncHandler(async (req, res) => {
      const access = await loadAccess(req, res);
      if (!access) return;
      const userId = accountId(req);
      if (!userId || !req.user) {
        return res.status(401).json({ error: "Account sign-in required" });
      }
      const parsed = messageSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid message" });
      try {
        const visible = await getVisibleOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          threadId: req.params.threadId,
          userId,
        });
        if (visible.audience.kind === "drawing" && !canEditDrawing(access)) {
          return res.status(403).json({ error: "Edit access required" });
        }
        const { thread, event } = await appendOrchestratorThreadMessage({
          prisma,
          drawingId: req.params.id,
          threadId: req.params.threadId,
          userId,
          displayName: req.user.name,
          text: parsed.data.text,
        });
        publishBoardAgentThreadEvent({ io, presences, thread, event });
        return res.status(201).json({ event });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );
};
