import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateApiKey, serializeApiKeyScopes } from "../../auth/apiKeys";
import { createAuthMiddleware } from "../../middleware/auth";
import type { AgentRuntimeAdapter, AgentRuntimeConnection } from "../../agent/runtime/contracts";
import { AgentRuntimeGateway } from "../../agent/runtime/gateway";
import { AgentRuntimeRegistry } from "../../agent/runtime/registry";
import { PresenceRegistry } from "../../server/presenceRegistry";
import { BOARD_AGENT_RUNTIME_EVENT } from "../../server/socketPresence";
import {
  AGENT_EVENT_REAUTHORIZE_INTERVAL_MS,
  registerDrawingRuntimeRoutes,
} from "./drawingRuntimeRoutes";

const build = (params: { scopes: string[]; drawingAccess: "owner" | "view" | "none" }) => {
  const generated = generateApiKey();
  let drawingAccess = params.drawingAccess;
  let mountedRunId: string | null = null;
  const emissions: Array<{ presenceId: string; event: string; payload: unknown }> = [];
  const subscriptionClose = vi.fn();
  let subscriptionListener: ((event: { status: "working" | "idle" }) => unknown) | null = null;
  let finishSubscription!: () => void;
  const subscriptionClosed = new Promise<void>((resolve) => {
    finishSubscription = resolve;
  });
  type LookupBarrier = {
    entered: Promise<void>;
    isEntered: () => boolean;
    release: () => void;
  };
  const lookupBarriers: Array<{
    markEntered: () => void;
    waitForRelease: Promise<void>;
  }> = [];
  const delayNextMountLookup = (): LookupBarrier => {
    let entered = false;
    let markEntered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      markEntered = () => {
        entered = true;
        resolve();
      };
    });
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    lookupBarriers.push({ markEntered, waitForRelease });
    return { entered: enteredPromise, isEntered: () => entered, release };
  };
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
    subscribe: vi.fn(async (_connection, _handle, listener) => {
      subscriptionListener = listener;
      return {
        close: subscriptionClose,
        closed: subscriptionClosed,
      };
    }),
  };
  const connection: AgentRuntimeConnection = {
    id: "runtime",
    label: "Runtime",
    adapterId: adapter.id,
    audience: { kind: "installation" },
    profiles: [{ id: "default", label: "Default" }],
    policyCapabilities: ["agent:read", "agent:run", "agent:prompt"],
    costBearer: { ownerKind: "operator", ownerId: "test-operator", label: "Test operator" },
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
    agentRunMount: {
      findUnique: vi.fn(async ({ where }: any) => {
        const barrier = lookupBarriers.shift();
        if (barrier) {
          barrier.markEntered();
          await barrier.waitForRelease;
        }
        return where.runId === mountedRunId
          ? {
              runId: mountedRunId,
              drawingId: "drawing-1",
              revisionId: "immutable-revision-17",
              displayName: "Mounted Research",
              audienceKind: "private",
              audienceUserId: "user-1",
            }
          : null;
      }),
    },
  };
  const { optionalAuth } = createAuthMiddleware({
    prisma: prisma as any,
    authModeService: { getAuthEnabled: vi.fn(async () => true) } as any,
  });
  const app = express();
  app.use(express.json());
  const presences = new PresenceRegistry();
  presences.join("drawing-1", {
    presenceId: "owner-socket",
    accountId: "user-1",
    name: "Owner",
    initials: "OW",
    color: "#2563eb",
    kind: "owner",
    isActive: true,
    selectedElementIds: {},
    actor: "human",
  });
  presences.join("drawing-1", {
    presenceId: "foreign-socket",
    accountId: "user-2",
    name: "Viewer",
    initials: "VI",
    color: "#059669",
    kind: "member",
    isActive: true,
    selectedElementIds: {},
    actor: "human",
  });
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
    io: {
      to: (presenceId: string) => ({
        emit: (event: string, payload: unknown) => emissions.push({ presenceId, event, payload }),
      }),
    },
    presences,
  } as any);
  return {
    app,
    token: generated.token,
    start,
    subscriptionClose,
    setDrawingAccess: (access: typeof drawingAccess) => {
      drawingAccess = access;
    },
    setMountedRun: (runId: string) => {
      mountedRunId = runId;
    },
    delayNextMountLookup,
    emitRuntime: (status: "working" | "idle"): Promise<unknown> => {
      if (!subscriptionListener) throw new Error("Runtime subscription is not open");
      return Promise.resolve(subscriptionListener({ status }));
    },
    finishSubscription,
    emissions,
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

  it("projects runtime status through the persisted private mount audience", async () => {
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
    harness.setMountedRun(started.body.run.id);

    await request(harness.app)
      .get("/drawings/drawing-1/agent/run")
      .set("Authorization", `Bearer ${harness.token}`)
      .set("x-agent-run-capability", started.body.runCapability)
      .expect(200);

    const runtimeEvents = harness.emissions.filter(
      (emission) => emission.event === BOARD_AGENT_RUNTIME_EVENT,
    );
    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        presenceId: "owner-socket",
        payload: expect.objectContaining({
          runId: started.body.run.id,
          revisionId: "immutable-revision-17",
          displayName: "Mounted Research",
          visibility: "private",
        }),
      }),
    ]);
    expect(runtimeEvents.some((emission) => emission.presenceId === "foreign-socket")).toBe(false);
  });

  it("keeps runtime Presence ordered when mount lookups complete out of order", async () => {
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
    harness.setMountedRun(started.body.run.id);

    let opened!: () => void;
    const streamOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const streamFinished = new Promise<void>((resolve, reject) => {
      request(harness.app)
        .post("/drawings/drawing-1/agent/events")
        .set("Authorization", `Bearer ${harness.token}`)
        .send({ runCapability: started.body.runCapability })
        .buffer(false)
        .parse((response, done) => {
          response.on("data", opened);
          response.on("end", () => done(null, undefined));
        })
        .end((error) => (error ? reject(error) : resolve()));
    });
    await streamOpened;

    const older = harness.delayNextMountLookup();
    const newer = harness.delayNextMountLookup();
    const olderPublished = harness.emitRuntime("idle");
    await older.entered;
    const newerPublished = harness.emitRuntime("working");
    await new Promise<void>((resolve) => setImmediate(resolve));

    if (newer.isEntered()) {
      newer.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      older.release();
    } else {
      older.release();
      await newer.entered;
      newer.release();
    }
    await Promise.all([olderPublished, newerPublished]);

    const statuses = harness.emissions
      .filter((emission) => emission.event === BOARD_AGENT_RUNTIME_EVENT)
      .map((emission) => (emission.payload as { status: string }).status);
    expect(statuses).toHaveLength(3);
    expect(statuses.slice(-2)).toEqual(["idle", "working"]);

    harness.finishSubscription();
    await streamFinished;
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
