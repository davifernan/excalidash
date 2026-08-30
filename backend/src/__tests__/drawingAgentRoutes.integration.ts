/**
 * The narrow agent operations surface (immutable mounts/tools plus
 * `POST .../agent/ops`) end to end through the
 * real Express app, a real database, and a real minted agent token -- not
 * just the auth-layer route gate (auth.agentToken.test.ts, mocked) or the
 * pure op-application function (agent/applyOps.test.ts, no HTTP/DB at all).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";
import { sha256Text } from "../agent/canonicalJson";
import { acceptDispatchReceipt } from "../agent/dispatchReceipt";

describe("Agent operations routes (NIL-382)", () => {
  const userAgent = "vitest-agent-ops-routes";
  let prisma: PrismaClient;
  let app: any;

  let owner: { id: string; email: string };
  let ownerToken: string;
  let ownerAgent: any;
  let ownerCsrfHeaderName: string;
  let ownerCsrfToken: string;

  let drawingId: string;
  let agentToken: string;
  let readOnlyAgentToken: string;

  const signAccessToken = (user: { id: string; email: string }) => {
    const signOptions: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );
  };

  const mintAgentToken = async (scopes?: string[]) => {
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Agent", drawingId, ...(scopes ? { scopes } : {}) });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  const mount = async () => {
    const mounted = await ownerAgent
      .post(`/drawings/${drawingId}/agent/mounts`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({});
    expect(mounted.status).toBe(201);
    return mounted.body;
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });

    const passwordHash = await bcrypt.hash("password123", 10);
    owner = await prisma.user.create({
      data: {
        email: "agent-ops-owner@test.local",
        passwordHash,
        name: "Owner",
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true },
    });
    ownerToken = signAccessToken(owner);

    ownerAgent = request.agent(app);
    const csrfRes = await ownerAgent.get("/csrf-token").set("User-Agent", userAgent);
    ownerCsrfHeaderName = csrfRes.body.header;
    ownerCsrfToken = csrfRes.body.token;

    const drawing = await prisma.drawing.create({
      data: {
        name: "Agent Board",
        elements: JSON.stringify([{ id: "el-1", type: "rectangle", x: 0, y: 0, isDeleted: false }]),
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
      select: { id: true },
    });
    drawingId = drawing.id;

    agentToken = await mintAgentToken();
    readOnlyAgentToken = await mintAgentToken(["drawing:read"]);
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates an immutable read mount and explores it without a scene dump", async () => {
    const mounted = await mount();
    const res = await request(app)
      .post(`/drawings/${drawingId}/agent/mounts/${mounted.runId}/tools/overview`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("x-agent-mount-token", mounted.capabilityToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.revisionId).toBe(mounted.revisionId);
    // No registered Context means no effective readable element, rather than
    // an implicit board-wide fallback.
    expect(res.body.result).toEqual({ contextCount: 0, elementCount: 0, countsByType: {} });
    expect(typeof res.body.resultHash).toBe("string");
  });

  it("removes the old mutable full-scene read instead of keeping a compatibility path", async () => {
    const res = await request(app)
      .get(`/drawings/${drawingId}/agent/elements`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("a read-only agent token (drawing:read only) can mount but not apply ops", async () => {
    const mounted = await mount();

    const ops = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${readOnlyAgentToken}`)
      .send({
        version: mounted.sourceDrawingVersion,
        ops: [{ op: "create", element: { type: "ellipse", x: 1, y: 1 } }],
      });
    // These routes use optionalAuth: a request that fails
    // isApiKeyRequestAuthorized() gets req.authError set and never attaches a
    // principal, so the route's own access check sees "no principal" and
    // respondWithAuthErrorIfPresent answers 401 -- the same "invalid token"
    // shape every other optionalAuth route in this codebase uses for a
    // rejected API key, not a 403.
    expect(ops.status).toBe(401);
  });

  it("REAL ATTACK: an agent token bound to this board is refused on a different board's agent routes", async () => {
    const other = await prisma.drawing.create({
      data: {
        name: "Someone else's board",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
      select: { id: true },
    });
    const res = await request(app)
      .post(`/drawings/${other.id}/agent/mounts`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(401);
  });

  it("REAL ATTACK: an agent token is refused on the full-scene PUT for its own board -- the agent surface is the three agent routes, not the whole board", async () => {
    const res = await request(app)
      .put(`/drawings/${drawingId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ version: 1, elements: [], appState: {} });
    expect(res.status).toBe(401);
  });

  it("rejects a three-Context public dispatch unless the human explicitly approves fan-out", async () => {
    const before = await prisma.agentDispatchReceipt.count();
    const res = await ownerAgent
      .post(
        `/drawings/${drawingId}/orchestrator-threads/00000000-0000-4000-8000-000000000001/dispatches`,
      )
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({
        publicThreadId: "00000000-0000-4000-8000-000000000002",
        objectiveSummary: "Publish three results",
        targetContextIds: [
          "00000000-0000-4000-8000-000000000003",
          "00000000-0000-4000-8000-000000000004",
          "00000000-0000-4000-8000-000000000005",
        ],
        requestedCapabilities: ["agent:run", "board:write"],
        budget: { maxRuntimeMs: 60_000 },
        expectedArtifacts: [],
        connectionId: "default",
        profileId: "default",
        displayName: "Fan-out agent",
        approval: { publicEffect: true },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FANOUT_APPROVAL_REQUIRED");
    expect(await prisma.agentDispatchReceipt.count()).toBe(before);
    expect(await prisma.contextLease.count()).toBe(0);
  });

  it("POST .../agent/ops applies create/update/delete atomically and bumps the version", async () => {
    const before = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    const version = before.version;

    const res = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        version,
        ops: [
          { op: "create", element: { type: "ellipse", x: 5, y: 5 } },
          { op: "update", id: "el-1", patch: { x: 10 } },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);
    const live = res.body.elements.filter((element: any) => !element.isDeleted);
    expect(live).toHaveLength(2);
    const updatedRect = res.body.elements.find((element: any) => element.id === "el-1");
    expect(updatedRect.x).toBe(10);
    // Seeded with no `version` field at all -- applyOperations treats a
    // missing version as 0, so its first update lands at 1, not 2.
    expect(updatedRect.version).toBe(1);

    const created = res.body.elements.find((element: any) => element.type === "ellipse");
    expect(created.id).not.toBe("el-1");
    expect(created.version).toBe(1);
  });

  it("rejects a batch that references an unknown element id, discarding the WHOLE batch -- not the valid ops within it", async () => {
    const before = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    const version = before.version;

    const res = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        version,
        ops: [
          { op: "create", element: { type: "diamond", x: 0, y: 0 } },
          { op: "update", id: "does-not-exist", patch: { x: 1 } },
        ],
      });
    expect(res.status).toBe(400);

    const after = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    // Version unchanged, and no "diamond" element appeared -- the valid op in
    // the same batch as the failing one was NOT applied on its own.
    expect(after.version).toBe(version);
    expect(JSON.parse(after.elements).some((element: any) => element.type === "diamond")).toBe(
      false,
    );
  });

  it("rejects a batch computed against a stale version (VERSION_CONFLICT), same optimistic-concurrency contract as the full-scene PUT", async () => {
    const res = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${agentToken}`)
      // A large-but-valid version, not -1: opsBatchSchema's version field is
      // z.number().int().nonnegative(), so a negative number fails Zod
      // validation (400) before ever reaching the semantic version-conflict
      // check this test means to exercise.
      .send({ version: 999999, ops: [{ op: "create", element: { type: "text", x: 0, y: 0 } }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
  });

  it("rejects a batch that tries to set server-assigned fields (id/version/versionNonce)", async () => {
    const before = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    const res = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        version: before.version,
        ops: [{ op: "create", element: { type: "text", x: 0, y: 0, version: 999 } }],
      });
    expect(res.status).toBe(400);
  });

  it("rejects a batch over the MAX_OPS_PER_BATCH limit", async () => {
    const before = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    const res = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        version: before.version,
        ops: Array.from({ length: 51 }, () => ({
          op: "create",
          element: { type: "text", x: 0, y: 0 },
        })),
      });
    expect(res.status).toBe(400);
  });

  it("confirms a public effect only in the same transaction as the real drawing write", async () => {
    const before = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    const frameId = `dispatch-frame-${randomUUID()}`;
    const elements = [
      ...JSON.parse(before.elements),
      { id: frameId, type: "frame", x: 0, y: 0, width: 500, height: 500, isDeleted: false },
    ];
    const seeded = await prisma.drawing.update({
      where: { id: drawingId },
      data: { elements: JSON.stringify(elements), version: { increment: 1 } },
    });
    const context = await prisma.agentContext.create({
      data: { drawingId, frameElementId: frameId },
    });
    const privateThread = await prisma.agentThread.create({
      data: {
        drawingId,
        threadKind: "orchestrator",
        audienceKind: "private",
        audienceUserId: owner.id,
        title: "Local",
        anchorX: 10,
        anchorY: 20,
      },
    });
    const publicThread = await prisma.agentThread.create({
      data: {
        drawingId,
        threadKind: "orchestrator",
        audienceKind: "drawing",
        title: "Multiplayer",
        anchorElementId: "thread-card",
      },
    });
    const revision = await prisma.agentBoardRevision.create({
      data: {
        drawingId,
        sourceDrawingVersion: seeded.version,
        contentHash: `dispatch-${randomUUID()}`,
        elements: seeded.elements,
        appState: seeded.appState,
        files: seeded.files,
        contextMap: JSON.stringify([{ id: context.id, frameElementId: frameId, pinned: false }]),
      },
    });
    const runId = randomUUID();
    const dispatchId = randomUUID();
    const mountToken = `exd_mount_${randomUUID()}`;
    await prisma.agentRunMount.create({
      data: {
        runId,
        drawingId,
        revisionId: revision.id,
        allowedContextIds: JSON.stringify([context.id]),
        capabilities: JSON.stringify(["board:explore"]),
        capabilityTokenHash: sha256Text(mountToken),
        displayName: "Public effect agent",
        audienceKind: "drawing",
      },
    });
    const leaseGeneration = randomUUID();
    const now = new Date();
    await prisma.contextLease.create({
      data: {
        contextId: context.id,
        leaseGeneration,
        holderOrchestratorId: publicThread.id,
        initiatedByUserId: owner.id,
        runId,
        acquiredAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        endHorizonAt: new Date(now.getTime() + 60_000),
      },
    });
    await acceptDispatchReceipt({
      prisma,
      dispatchId,
      drawingId,
      originThreadId: privateThread.id,
      publicThreadId: publicThread.id,
      initiatedByUserId: owner.id,
      objectiveSummary: "Move the comparison into the public frame",
      targetContextIds: [context.id],
      revisionId: revision.id,
      effectiveCapabilities: ["agent:run", "board:write"],
      budget: { maxRuntimeMs: 60_000 },
      expectedArtifacts: ["Board update"],
      runId,
      leases: [{ contextId: context.id, leaseGeneration }],
      runtimeRequest: {
        connectionId: "test",
        profileId: "test",
        displayName: "Public effect agent",
        mountCapabilityToken: mountToken,
        allowedContextIds: [context.id],
      },
      effectDeadlineAt: new Date(now.getTime() + 60_000),
      now,
    });

    const rejected = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("x-agent-mount-token", "wrong-mount-token")
      .send({
        version: seeded.version,
        ops: [{ op: "update", id: "el-1", patch: { x: 44 } }],
        dispatchReceipt: { id: dispatchId, runId },
      });
    expect(rejected.status).toBe(403);
    expect((await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } })).version).toBe(
      seeded.version,
    );
    expect(
      await prisma.agentDispatchReceipt.findUniqueOrThrow({ where: { id: dispatchId } }),
    ).toMatchObject({ effectStatus: "pending" });

    const res = await request(app)
      .post(`/drawings/${drawingId}/agent/ops`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("x-agent-mount-token", mountToken)
      .send({
        version: seeded.version,
        ops: [{ op: "update", id: "el-1", patch: { x: 44 } }],
        dispatchReceipt: { id: dispatchId, runId },
      });
    expect(res.status).toBe(200);
    const persistedReceipt = await prisma.agentDispatchReceipt.findUniqueOrThrow({
      where: { id: dispatchId },
    });
    expect(persistedReceipt).toMatchObject({
      executionStatus: "queued",
      effectStatus: "committed",
    });
    expect(JSON.parse(persistedReceipt.effectEvidence!)).toEqual({
      kind: "drawing.version",
      drawingId,
      version: seeded.version + 1,
    });
    expect(
      (await prisma.contextLease.findUnique({ where: { contextId: context.id } }))?.releasedAt,
    ).not.toBeNull();
  });
});
