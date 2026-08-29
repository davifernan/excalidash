import express from "express";
import { z } from "zod";
import { canViewDrawing, getDrawingAccess, type DrawingPrincipal } from "../../authz/sharing";
import { AGENT_RUNTIME_CAPABILITIES, AgentRuntimeError } from "../../agent/runtime/contracts";
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
  } = context;

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
        return res.json(
          await agentRuntimeGateway.status({
            drawingId: req.params.id,
            access: authorized.access,
            principal: authorized.principal,
            runCapability: parsed.data.runCapability,
          }),
        );
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
        return res.json(
          await agentRuntimeGateway.prompt({
            drawingId: req.params.id,
            access: authorized.access,
            principal: authorized.principal,
            runCapability: parsed.data.runCapability,
            text: parsed.data.text,
          }),
        );
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
      const closeStream = () => {
        if (keepAlive) clearInterval(keepAlive);
        subscription?.close();
      };
      res.once("close", closeStream);
      try {
        const params = {
          drawingId: req.params.id,
          access: authorized.access,
          principal: authorized.principal,
          runCapability: parsed.data.runCapability,
        };
        const current = await agentRuntimeGateway.status(params);
        const pendingEvents: unknown[] = [];
        let streamReady = false;
        subscription = await agentRuntimeGateway.subscribe(params, (event) => {
          if (!streamReady) {
            pendingEvents.push(event);
          } else if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        });
        void subscription.closed.then(() => {
          if (!res.writableEnded) res.end();
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
        for (const event of pendingEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
        keepAlive = setInterval(() => {
          if (!res.writableEnded) res.write(": keep-alive\n\n");
        }, 20_000);
      } catch (error) {
        if (!res.headersSent) return respondRuntimeError(res, error);
        res.end();
      }
    }),
  );
};
