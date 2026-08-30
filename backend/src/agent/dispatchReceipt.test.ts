import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/client";
import { cleanupTestDb, createTestUser, getTestPrisma, setupTestDb } from "../__tests__/testUtils";
import { sha256Text } from "./canonicalJson";
import {
  DISPATCH_START_DEADLINE_MS,
  acceptDispatchReceipt,
  acknowledgeDispatchRuntime,
  commitDispatchBoardEffect,
  listPublicDispatchReceipts,
  listUnresolvedDispatchReceipts,
  observeDispatchRuntime,
  reconcileDispatchReceipt,
} from "./dispatchReceipt";
import { processDispatchOutbox } from "./dispatchWorker";

describe("DispatchReceipt: honest public-effect evidence (NIL-679)", () => {
  let prisma: PrismaClient;
  let ownerId: string;
  let drawingId: string;
  let contextId: string;
  let privateThreadId: string;
  let publicThreadId: string;
  let runId: string;
  let revisionId: string;
  const mountToken = "exd_mount_test-receipt-token";
  const leaseGeneration = "lease-generation-1";
  const acceptedAt = new Date("2026-08-30T04:00:00.000Z");

  beforeAll(() => {
    setupTestDb();
    prisma = getTestPrisma();
  });
  afterAll(async () => cleanupTestDb(prisma));

  beforeEach(async () => {
    await cleanupTestDb(prisma);
    ownerId = (await createTestUser(prisma, `dispatch-owner-${Date.now()}@example.com`)).id;
    const drawing = await prisma.drawing.create({
      data: {
        name: "Dispatch board",
        userId: ownerId,
        elements: "[]",
        appState: "{}",
        files: "{}",
      },
    });
    drawingId = drawing.id;
    const context = await prisma.agentContext.create({
      data: { drawingId, frameElementId: "frame-1" },
    });
    contextId = context.id;
    const privateThread = await prisma.agentThread.create({
      data: {
        drawingId,
        threadKind: "orchestrator",
        audienceKind: "private",
        audienceUserId: ownerId,
        title: "Local",
        anchorX: 1,
        anchorY: 2,
      },
    });
    privateThreadId = privateThread.id;
    const publicThread = await prisma.agentThread.create({
      data: {
        drawingId,
        threadKind: "orchestrator",
        audienceKind: "drawing",
        title: "Multiplayer",
        anchorElementId: "thread-card",
      },
    });
    publicThreadId = publicThread.id;
    const revision = await prisma.agentBoardRevision.create({
      data: {
        drawingId,
        sourceDrawingVersion: 1,
        contentHash: `hash-${Date.now()}`,
        elements: "[]",
        appState: "{}",
        files: "{}",
        contextMap: "[]",
      },
    });
    revisionId = revision.id;
    runId = `run-${Date.now()}`;
    await prisma.agentRunMount.create({
      data: {
        runId,
        drawingId,
        revisionId,
        allowedContextIds: JSON.stringify([contextId]),
        capabilities: JSON.stringify(["board:explore"]),
        capabilityTokenHash: sha256Text(mountToken),
        displayName: "Research agent",
        audienceKind: "drawing",
      },
    });
    await prisma.contextLease.create({
      data: {
        contextId,
        leaseGeneration,
        holderOrchestratorId: "dispatch:test",
        initiatedByUserId: ownerId,
        runId,
        acquiredAt: acceptedAt,
        expiresAt: new Date(acceptedAt.getTime() + 10 * 60_000),
        endHorizonAt: new Date(acceptedAt.getTime() + 20 * 60_000),
      },
    });
  });

  const accept = (id = `dispatch-${Date.now()}`) =>
    acceptDispatchReceipt({
      prisma,
      dispatchId: id,
      drawingId,
      originThreadId: privateThreadId,
      publicThreadId,
      initiatedByUserId: ownerId,
      objectiveSummary: "Publish the approved comparison to Context A",
      targetContextIds: [contextId],
      revisionId,
      effectiveCapabilities: ["agent:run", "board:write"],
      budget: { maxRuntimeMs: 20 * 60_000 },
      expectedArtifacts: ["Board comparison"],
      runId,
      leases: [{ contextId, leaseGeneration }],
      runtimeRequest: {
        connectionId: "connection-1",
        profileId: "profile-1",
        displayName: "Research agent",
        mountCapabilityToken: mountToken,
        allowedContextIds: [contextId],
      },
      effectDeadlineAt: new Date(acceptedAt.getTime() + 20 * 60_000),
      now: acceptedAt,
    });

  it("publishes only the approved summary from a private origin and never claims acceptance is success", async () => {
    const receipt = await accept();
    expect(receipt).toMatchObject({
      originVisibility: "private",
      objectiveSummary: "Publish the approved comparison to Context A",
      admission: "accepted",
      execution: "queued",
      effect: "pending",
    });
    expect(receipt).not.toHaveProperty("originThreadId");
    expect(JSON.stringify(receipt)).not.toContain(privateThreadId);
    expect(await listPublicDispatchReceipts({ prisma, drawingId, publicThreadId })).toEqual([
      expect.objectContaining({ id: receipt.id, originVisibility: "private" }),
    ]);
  });

  it("turns missing runtime acknowledgement into outcome_unknown by server deadline and releases authority", async () => {
    const receipt = await accept();
    const reconciled = await reconcileDispatchReceipt({
      prisma,
      dispatchId: receipt.id,
      now: new Date(acceptedAt.getTime() + DISPATCH_START_DEADLINE_MS + 1),
    });
    expect(reconciled).toMatchObject({ execution: "outcome_unknown", effect: "pending" });
    expect(
      await prisma.agentDispatchOutbox.findUnique({ where: { dispatchId: receipt.id } }),
    ).toMatchObject({ state: "outcome_unknown", payload: null });
    expect(
      (await prisma.contextLease.findUnique({ where: { contextId } }))?.releasedAt,
    ).not.toBeNull();
    expect(
      await prisma.agentDispatchReceiptEvent.findMany({
        where: { dispatchId: receipt.id },
        orderBy: { sequence: "asc" },
      }),
    ).toEqual([
      expect.objectContaining({ sequence: 1, kind: "dispatch.accepted" }),
      expect.objectContaining({ sequence: 2, kind: "runtime.outcome_unknown" }),
    ]);
  });

  it("does not let a deliberately delayed running observation overwrite terminal success", async () => {
    const receipt = await accept();
    await acknowledgeDispatchRuntime({
      prisma,
      dispatchId: receipt.id,
      runtimeCapability: "encrypted-runtime-capability",
      runtimeStatus: "working",
      now: new Date(acceptedAt.getTime() + 100),
    });
    const succeeded = await observeDispatchRuntime({
      prisma,
      dispatchId: receipt.id,
      runtimeStatus: "done",
      now: new Date(acceptedAt.getTime() + 200),
    });
    expect(succeeded).toMatchObject({ execution: "succeeded", effect: "pending" });
    expect(
      await observeDispatchRuntime({
        prisma,
        dispatchId: receipt.id,
        runtimeStatus: "working",
        now: new Date(acceptedAt.getTime() + 150),
      }),
    ).toBeNull();
    expect(
      await prisma.agentDispatchReceipt.findUnique({ where: { id: receipt.id } }),
    ).toMatchObject({ executionStatus: "succeeded", effectStatus: "pending" });
  });

  it("marks public effect committed only inside an authorized mounted write transaction", async () => {
    const receipt = await accept();
    const committed = await prisma.$transaction((tx) =>
      commitDispatchBoardEffect({
        tx,
        drawingId,
        dispatchId: receipt.id,
        runId,
        mountCapabilityToken: mountToken,
        drawingVersion: 2,
        now: new Date(acceptedAt.getTime() + 500),
      }),
    );
    expect(committed).toMatchObject({
      execution: "queued",
      effect: "committed",
      effectEvidence: { kind: "drawing.version", drawingId, version: 2 },
    });
    await expect(
      prisma.$transaction((tx) =>
        commitDispatchBoardEffect({
          tx,
          drawingId,
          dispatchId: receipt.id,
          runId,
          mountCapabilityToken: "wrong-token",
          drawingVersion: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: "DISPATCH_EFFECT_NOT_ALLOWED" });
  });

  it("never interprets a closed runtime stream as success", async () => {
    const receipt = await accept();
    const gateway = {
      start: async () => ({
        run: { id: runId, displayName: "Research agent", status: "working", capabilities: [] },
        runCapability: "runtime-capability",
        expiresAt: new Date(acceptedAt.getTime() + 60_000).toISOString(),
      }),
      subscribe: async () => ({ close: () => undefined, closed: Promise.resolve() }),
    };
    const observed = await processDispatchOutbox({
      prisma,
      gateway: gateway as any,
      dispatchId: receipt.id,
      now: new Date(acceptedAt.getTime() + 100),
    });
    expect(observed).toMatchObject({ execution: "running", effect: "pending" });

    const reconciled = await reconcileDispatchReceipt({
      prisma,
      dispatchId: receipt.id,
      now: new Date(acceptedAt.getTime() + 61_000),
    });
    expect(reconciled).toMatchObject({ execution: "outcome_unknown", effect: "pending" });
  });

  it("does not retry after a crash between foreign start and durable acknowledgement", async () => {
    const receipt = await accept();
    let starts = 0;
    const gateway = {
      start: async () => {
        starts += 1;
        return {
          run: { id: runId, displayName: "Research agent", status: "working", capabilities: [] },
          runCapability: "runtime-capability",
          expiresAt: new Date(acceptedAt.getTime() + 60_000).toISOString(),
        };
      },
      subscribe: async () => ({ close: () => undefined, closed: Promise.resolve() }),
    };
    await expect(
      processDispatchOutbox({
        prisma,
        gateway: gateway as any,
        dispatchId: receipt.id,
        now: new Date(acceptedAt.getTime() + 100),
        afterForeignStart: async () => {
          throw new Error("simulated process death");
        },
      }),
    ).rejects.toThrow("simulated process death");
    expect(
      await processDispatchOutbox({
        prisma,
        gateway: gateway as any,
        dispatchId: receipt.id,
        now: new Date(acceptedAt.getTime() + 200),
      }),
    ).toBeNull();
    expect(starts).toBe(1);
    expect(
      await prisma.agentDispatchOutbox.findUnique({ where: { dispatchId: receipt.id } }),
    ).toMatchObject({ state: "sending" });
  });

  it("reconstructs restart work without making an already-sending start claimable again", async () => {
    const pending = await accept();
    expect(await listUnresolvedDispatchReceipts({ prisma })).toEqual([
      expect.objectContaining({ id: pending.id, execution: "queued", effect: "pending" }),
    ]);

    expect(
      await prisma.agentDispatchOutbox.updateMany({
        where: { dispatchId: pending.id, state: "pending" },
        data: { state: "sending", attemptStartedAt: acceptedAt },
      }),
    ).toMatchObject({ count: 1 });
    const starts: string[] = [];
    const gateway = {
      start: async () => {
        starts.push(pending.id);
        throw new Error("must not be reached");
      },
    };
    for (const receipt of await listUnresolvedDispatchReceipts({ prisma })) {
      expect(
        await processDispatchOutbox({
          prisma,
          gateway: gateway as any,
          dispatchId: receipt.id,
        }),
      ).toBeNull();
    }
    expect(starts).toEqual([]);

    const unknown = await reconcileDispatchReceipt({
      prisma,
      dispatchId: pending.id,
      now: new Date(acceptedAt.getTime() + DISPATCH_START_DEADLINE_MS + 1),
    });
    expect(unknown).toMatchObject({ execution: "outcome_unknown", effect: "pending" });
  });
});
