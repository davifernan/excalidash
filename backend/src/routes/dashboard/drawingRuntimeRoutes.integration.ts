import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateApiKey, serializeApiKeyScopes } from "../../auth/apiKeys";
import { createAuthMiddleware } from "../../middleware/auth";
import type { AgentRuntimeAdapter, AgentRuntimeConnection } from "../../agent/runtime/contracts";
import { AgentRuntimeGateway } from "../../agent/runtime/gateway";
import { AgentRuntimeRegistry } from "../../agent/runtime/registry";
import {
  AGENT_EVENT_REAUTHORIZE_INTERVAL_MS,
  registerDrawingRuntimeRoutes,
} from "./drawingRuntimeRoutes";

const build = (params: { scopes: string[]; drawingAccess: "owner" | "view" | "none" }) => {
  const generated = generateApiKey();
  let drawingAccess = params.drawingAccess;
  const subscriptionClose = vi.fn();
  const start = vi.fn(async (_connection: AgentRuntimeConnection, input: any) => ({
    handle: "opaque",
    status: "working" as const,
    displayName: input.displayName,
  }));
  const adapter: AgentRuntimeAdapter = {
    id: "stub",
    health: vi.fn(async () => ({ connected: true, status: "connected" as const })),
    start,
    prompt: vi.fn(async () => ({ status: "working" as const })),
    status: vi.fn(async () => ({ status: "idle" as const })),
    subscribe: vi.fn(async () => ({
      close: subscriptionClose,
      closed: new Promise<void>(() => undefined),
    })),
  };
  const connection: AgentRuntimeConnection = {
    id: "runtime",
    label: "Runtime",
    adapterId: adapter.id,
    audience: { kind: "installation" },
    profiles: [{ id: "default", label: "Default" }],
    policyCapabilities: ["agent:read", "agent:run", "agent:prompt"],
    adapterConfig: {},
  };
  const prisma = {
    apiKey: {
      findUnique: vi.fn(async () => ({
        id: "key-1",
        keyId: generated.keyId,
        tokenHash: generated.tokenHash,
        scopes: serializeApiKeyScopes(params.scopes),
        drawingId: "drawing-1",
        expiresAt: null,
        revokedAt: null,
        user: {
          id: "user-1",
          username: "user",
          email: "user@example.test",
          name: "User",
          role: "USER",
          mustResetPassword: false,
          isActive: true,
        },
      })),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
    drawing: {
      findUnique: vi.fn(async () => ({
        userId: drawingAccess === "owner" ? "user-1" : "owner-2",
        collectionId: null,
      })),
    },
    drawingPermission: {
      findUnique: vi.fn(async () => (drawingAccess === "view" ? { permission: "view" } : null)),
    },
    drawingLinkShare: { findFirst: vi.fn(async () => null) },
  };
  const { optionalAuth } = createAuthMiddleware({
    prisma: prisma as any,
    authModeService: { getAuthEnabled: vi.fn(async () => true) } as any,
  });
  const app = express();
  app.use(express.json());
  registerDrawingRuntimeRoutes(app, {
    prisma,
    optionalAuth,
    asyncHandler: (handler: any) => (req: any, res: any, next: any) =>
      Promise.resolve(handler(req, res, next)).catch(next),
    getRequestPrincipal: async (req: any) => req.principal ?? null,
    getShareToken: () => null,
    respondWithAuthErrorIfPresent: (req: any, res: any) => {
      if (!req.authError) return false;
      res.status(401).json({ error: "Unauthorized" });
      return true;
    },
    agentRuntimeGateway: new AgentRuntimeGateway(
      new AgentRuntimeRegistry({ adapters: [adapter], connections: [connection] }),
      "secret",
    ),
  } as any);
  return {
    app,
    token: generated.token,
    start,
    subscriptionClose,
    setDrawingAccess: (access: typeof drawingAccess) => {
      drawingAccess = access;
    },
  };
};

const runBody = {
  connectionId: "runtime",
  profileId: "default",
  displayName: "Research",
  approvedCapabilities: ["agent:run"],
};

describe("authenticated agent runtime gateway", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows agent:run without requiring or granting board write", async () => {
    const harness = build({ scopes: ["agent:run"], drawingAccess: "owner" });
    const response = await request(harness.app)
      .post("/drawings/drawing-1/agent/run")
      .set("Authorization", `Bearer ${harness.token}`)
      .send(runBody)
      .expect(201);
    expect(response.body.run.capabilities).toEqual(["agent:run"]);
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it("rejects before the adapter when the token lacks agent:run", async () => {
    const harness = build({ scopes: ["drawing:read"], drawingAccess: "owner" });
    await request(harness.app)
      .post("/drawings/drawing-1/agent/run")
      .set("Authorization", `Bearer ${harness.token}`)
      .send(runBody)
      .expect(401);
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("does not let delegation restore agent:run after the human lost edit access", async () => {
    const harness = build({ scopes: ["agent:run"], drawingAccess: "view" });
    const response = await request(harness.app)
      .post("/drawings/drawing-1/agent/run")
      .set("Authorization", `Bearer ${harness.token}`)
      .send(runBody)
      .expect(403);
    expect(response.body.code).toBe("RUN_CAPABILITY_FORBIDDEN");
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("closes an open event stream after the board access is revoked", async () => {
    vi.useFakeTimers();
    const harness = build({
      scopes: ["agent:read", "agent:run"],
      drawingAccess: "owner",
    });
    const started = await request(harness.app)
      .post("/drawings/drawing-1/agent/run")
      .set("Authorization", `Bearer ${harness.token}`)
      .send({
        ...runBody,
        approvedCapabilities: ["agent:read", "agent:run"],
      })
      .expect(201);

    let opened!: () => void;
    const streamOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let streamBody = "";
    const streamFinished = new Promise<void>((resolve, reject) => {
      request(harness.app)
        .post("/drawings/drawing-1/agent/events")
        .set("Authorization", `Bearer ${harness.token}`)
        .send({ runCapability: started.body.runCapability })
        .buffer(false)
        .parse((response, done) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            streamBody += chunk;
            opened();
          });
          response.on("end", () => done(null, streamBody));
        })
        .end((error) => (error ? reject(error) : resolve()));
    });

    await streamOpened;
    harness.setDrawingAccess("none");
    await vi.advanceTimersByTimeAsync(AGENT_EVENT_REAUTHORIZE_INTERVAL_MS);
    await streamFinished;

    expect(streamBody).toContain('"status":"idle"');
    expect(harness.subscriptionClose).toHaveBeenCalledOnce();
  });
});
