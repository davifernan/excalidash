import express from "express";
import { z } from "zod";
import { canViewDrawing, getDrawingAccess, type DrawingPrincipal } from "../../authz/sharing";
import { AGENT_RUNTIME_CAPABILITIES, AgentRuntimeError } from "../../agent/runtime/contracts";
import { loadBoardAgentRunPresence } from "../../agent/boardMount";
import { publishBoardAgentRuntime } from "../../server/socketPresence";
import type { DrawingRouteContext } from "./drawingRouteContext";

const startSchema = z.object({
  connectionId: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((name) => !/[\u0000-\u001f\u007f]/.test(name)),
  initialPrompt: z.string().trim().min(1).max(20_000).optional(),
  approvedCapabilities: z.array(z.enum(AGENT_RUNTIME_CAPABILITIES)).min(1).max(8),
});

const capabilitySchema = z.object({ runCapability: z.string().min(1).max(16_384) });
const promptSchema = capabilitySchema.extend({ text: z.string().trim().min(1).max(20_000) });
export const AGENT_EVENT_REAUTHORIZE_INTERVAL_MS = 20_000;

const respondRuntimeError = (res: express.Response, error: unknown) => {
  if (!(error instanceof AgentRuntimeError)) {
    return res.status(503).json({
      error: "Runtime unavailable",
      code: "RUNTIME_REQUEST_FAILED",
      message: "The agent runtime is currently unavailable.",
    });
  }
  const forbidden =
    error.code === "RUN_CAPABILITY_INVALID" ||
    error.code === "RUN_CAPABILITY_EXPIRED" ||
    error.code === "RUN_CAPABILITY_FORBIDDEN";
  const invalid = error.code === "RUNTIME_PROFILE_NOT_FOUND";
  return res.status(forbidden ? 403 : invalid ? 400 : 503).json({
    error: forbidden ? "Forbidden" : invalid ? "Invalid runtime request" : "Runtime unavailable",
    code: error.code,
    message: error.message,
  });
};

export const registerDrawingRuntimeRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    optionalAuth,
    asyncHandler,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    prisma,
    agentRuntimeGateway,
    io,
    presences,
  } = context;

  const runtimePresenceQueues = new Map<string, Promise<void>>();
  const projectRuntimePresence = async (
    drawingId: string,
    event: {
      id: string;
      status: "working" | "idle" | "blocked" | "done" | "unknown";
      displayName?: string;
    },
    occurredAt = new Date().toISOString(),
  ): Promise<void> => {
    const mounted = await loadBoardAgentRunPresence(prisma, drawingId, event.id);
    if (!mounted) return;
    publishBoardAgentRuntime({
      io,
      presences,
      event: {
        agentId: mounted.runId,
        runId: mounted.runId,
        drawingId: mounted.drawingId,
        revisionId: mounted.revisionId,
        // The runtime may report its own mutable label, but the board-facing
        // participant identity is part of the immutable per-run mount.
        displayName: mounted.displayName,
        status: event.status,
        audience: mounted.audience,
        occurredAt,
      },
    });
  };
  const publishRuntimePresence = (
    drawingId: string,
    event: {
      id: string;
      status: "working" | "idle" | "blocked" | "done" | "unknown";
      displayName?: string;
    },
  ): Promise<void> => {
    const occurredAt = new Date().toISOString();
    const queueKey = `${drawingId}\u0000${event.id}`;
    const previous = runtimePresenceQueues.get(queueKey) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => projectRuntimePresence(drawingId, event, occurredAt))
      .finally(() => {
        if (runtimePresenceQueues.get(queueKey) === queued) runtimePresenceQueues.delete(queueKey);
      });
    runtimePresenceQueues.set(queueKey, queued);
    return queued;
  };

  const authorize = async (
    req: express.Request,
    res: express.Response,
  ): Promise<{
    principal: DrawingPrincipal;
    access: Awaited<ReturnType<typeof getDrawingAccess>>;
  } | null> => {
    const principal = await getRequestPrincipal(req);
    const access = await getDrawingAccess({
      prisma,
      principal,
      drawingId: req.params.id,
      shareToken: getShareToken(req),
    });
    if (!principal || !canViewDrawing(access)) {
      if (respondWithAuthErrorIfPresent(req, res)) return null;
      res.status(404).json({ error: "Drawing not found", message: "Drawing does not exist" });
      return null;
    }
    return { principal, access };
  };

  app.get(
    "/drawings/:id/agent/runtime",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const authorized = await authorize(req, res);
      if (!authorized) return;
      return res.json({
        connections: await agentRuntimeGateway.connections(authorized.principal.userId),
      });
    }),
  );

  app.post(
    "/drawings/:id/agent/run",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const authorized = await authorize(req, res);
      if (!authorized) return;
      const parsed = startSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation error", message: "Invalid run request" });
      }
      try {
        return res.status(201).json(
          await agentRuntimeGateway.start({
            drawingId: req.params.id,
            access: authorized.access,
            principal: authorized.principal,
            ...parsed.data,
          }),
        );
      } catch (error) {
        return respondRuntimeError(res, error);
      }
    }),
  );

  app.get(
    "/drawings/:id/agent/run",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const authorized = await authorize(req, res);
      if (!authorized) return;
      const parsed = capabilitySchema.safeParse({
        runCapability: req.headers["x-agent-run-capability"],
      });
      if (!parsed.success) {
        return res.status(403).json({ error: "Forbidden", message: "Run capability required" });
      }
      try {
        const status = await agentRuntimeGateway.status({
          drawingId: req.params.id,
          access: authorized.access,
          principal: authorized.principal,
          runCapability: parsed.data.runCapability,
        });
        await publishRuntimePresence(req.params.id, status);
        return res.json(status);
      } catch (error) {
        return respondRuntimeError(res, error);
      }
    }),
  );

  app.post(
    "/drawings/:id/agent/prompt",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const authorized = await authorize(req, res);
      if (!authorized) return;
      const parsed = promptSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Validation error", message: "Invalid prompt request" });
      }
      try {
        const status = await agentRuntimeGateway.prompt({
          drawingId: req.params.id,
          access: authorized.access,
          principal: authorized.principal,
          runCapability: parsed.data.runCapability,
          text: parsed.data.text,
        });
        await publishRuntimePresence(req.params.id, status);
        return res.json(status);
      } catch (error) {
        return respondRuntimeError(res, error);
      }
    }),
  );

  app.post(
    "/drawings/:id/agent/events",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const authorized = await authorize(req, res);
      if (!authorized) return;
      const parsed = capabilitySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(403).json({ error: "Forbidden", message: "Run capability required" });
      }
      let subscription: Awaited<ReturnType<typeof agentRuntimeGateway.subscribe>> | null = null;
      let keepAlive: NodeJS.Timeout | null = null;
      let streamClosed = false;
      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        if (keepAlive) clearInterval(keepAlive);
        subscription?.close();
      };
      const endStream = () => {
        closeStream();
        if (!res.writableEnded) res.end();
      };
      res.once("close", closeStream);
      try {
        const runParams = {
          drawingId: req.params.id,
          access: authorized.access,
          principal: authorized.principal,
          runCapability: parsed.data.runCapability,
        };
        const current = await agentRuntimeGateway.status(runParams);
        await publishRuntimePresence(req.params.id, current);
        const pendingEvents: unknown[] = [];
        let streamReady = false;
        // Deliberately NOT built on backend/src/utils/inFlightCoalescer.ts:
        // this is a plain re-entrancy guard for a periodic side effect
        // (deciding whether to buffer an incoming event while a
        // reauthorization check is running), never a stored/awaited Promise
        // that callers share a result from. There is no "start work, return
        // its promise to concurrent callers" here to coalesce (see NIL-693).
        let reauthorizationInFlight = false;
        const flushPendingEvents = () => {
          if (!streamReady || streamClosed || res.writableEnded) return;
          for (const event of pendingEvents.splice(0)) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        };
        subscription = await agentRuntimeGateway.subscribe(runParams, (event) => {
          const presencePublished = publishRuntimePresence(req.params.id, event).catch(
            () => undefined,
          );
          if (!streamReady || reauthorizationInFlight) {
            pendingEvents.push(event);
          } else if (!streamClosed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return presencePublished;
        });
        void subscription.closed.then(() => {
          if (!res.writableEnded) endStream();
        });
        if (res.destroyed) {
          subscription.close();
          return;
        }
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(current)}\n\n`);
        streamReady = true;
        flushPendingEvents();
        keepAlive = setInterval(() => {
          if (reauthorizationInFlight || streamClosed || res.writableEnded) return;
          reauthorizationInFlight = true;
          void getDrawingAccess({
            prisma,
            principal: authorized.principal,
            drawingId: req.params.id,
            shareToken: getShareToken(req),
          })
            .then((access) => {
              agentRuntimeGateway.assertRunCapability({ ...runParams, access }, "agent:read");
              reauthorizationInFlight = false;
              flushPendingEvents();
              if (!streamClosed && !res.writableEnded) res.write(": keep-alive\n\n");
            })
            .catch(() => {
              reauthorizationInFlight = false;
              pendingEvents.length = 0;
              endStream();
            });
        }, AGENT_EVENT_REAUTHORIZE_INTERVAL_MS);
      } catch (error) {
        if (!res.headersSent) return respondRuntimeError(res, error);
        res.end();
      }
    }),
  );
};
