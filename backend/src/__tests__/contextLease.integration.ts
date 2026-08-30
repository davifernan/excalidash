import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/client";
import { registerAgentContext } from "../agent/boardContexts";
import { createAgentRunMount, executeAgentBoardTool } from "../agent/boardMount";
import {
  acquireContextLease,
  ContextLeaseHeldError,
  ContextLeaseNotHeldError,
  ContextLeaseTransferDeniedError,
  isContextLeaseHeldByRun,
  releaseContextLease,
  renewContextLease,
  transferContextLease,
} from "../agent/contextLease";
import { getTestPrisma, setupTestDb } from "./testUtils";

/**
 * NIL-680's own "Fertig, wenn" criteria, proven against a real SQLite
 * database with real concurrent writers -- not mocked, since the entire
 * point of the module is what happens when two callers race for real.
 */
describe("Context Lease (NIL-680)", () => {
  let prisma: PrismaClient;
  let userId: string;
  let otherUserId: string;

  const horizon = (ms: number) => new Date(Date.now() + ms);

  const newContext = async (frameId: string): Promise<{ contextId: string; drawingId: string }> => {
    const drawing = await prisma.drawing.create({
      data: {
        name: `Lease test ${frameId}`,
        elements: JSON.stringify([
          {
            id: frameId,
            type: "frame",
            x: 0,
            y: 0,
            width: 200,
            height: 200,
            angle: 0,
            isDeleted: false,
          },
        ]),
        appState: "{}",
        userId,
      },
    });
    const context = await registerAgentContext({
      prisma,
      drawingId: drawing.id,
      frameElementId: frameId,
    });
    return { contextId: context.id, drawingId: drawing.id };
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: { email: "lease-owner@example.com", passwordHash: "x", name: "Owner" },
    });
    userId = user.id;
    const other = await prisma.user.create({
      data: { email: "lease-other@example.com", passwordHash: "x", name: "Other" },
    });
    otherUserId = other.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("grants exactly one winner when two orchestrators race to dispatch to the same Context, and logs the busy signal", async () => {
    const { contextId } = await newContext("race-frame");

    const [a, b] = await Promise.allSettled([
      acquireContextLease({
        prisma,
        contextId,
        holderOrchestratorId: "orchestrator-a",
        initiatedByUserId: userId,
        runId: "run-a",
        ttlMs: 60_000,
        endHorizonAt: horizon(300_000),
      }),
      acquireContextLease({
        prisma,
        contextId,
        holderOrchestratorId: "orchestrator-b",
        initiatedByUserId: userId,
        runId: "run-b",
        ttlMs: 60_000,
        endHorizonAt: horizon(300_000),
      }),
    ]);

    const outcomes = [a, b];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContextLeaseHeldError);

    const winnerRunId = (fulfilled[0] as PromiseFulfilledResult<{ runId: string }>).value.runId;
    expect(["run-a", "run-b"]).toContain(winnerRunId);
    // Exactly one running dispatch: the loser never holds it.
    const loserRunId = winnerRunId === "run-a" ? "run-b" : "run-a";
    await expect(isContextLeaseHeldByRun({ prisma, contextId, runId: loserRunId })).resolves.toBe(
      false,
    );
    await expect(isContextLeaseHeldByRun({ prisma, contextId, runId: winnerRunId })).resolves.toBe(
      true,
    );

    // The busy signal is visible in the shared room, not just an in-memory rejection.
    const events = await prisma.contextLeaseEvent.findMany({ where: { contextId } });
    const busy = events.filter((e) => e.kind === "context.busy");
    expect(busy).toHaveLength(1);
    expect(busy[0]?.runId).toBe(loserRunId);
  });

  it("frees a crashed orchestrator's Context by expiry, and the Context becomes usable again", async () => {
    const { contextId } = await newContext("expiry-frame");
    const now = new Date();

    await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-crashed",
      initiatedByUserId: userId,
      runId: "run-crashed",
      ttlMs: 1_000,
      endHorizonAt: horizon(300_000),
      now,
    });

    // Still within TTL: a second orchestrator is correctly refused.
    await expect(
      acquireContextLease({
        prisma,
        contextId,
        holderOrchestratorId: "orchestrator-second",
        initiatedByUserId: userId,
        runId: "run-second",
        ttlMs: 60_000,
        endHorizonAt: horizon(300_000),
        now,
      }),
    ).rejects.toBeInstanceOf(ContextLeaseHeldError);

    // The crashed orchestrator never renews or releases. Time passes the TTL.
    const afterExpiry = new Date(now.getTime() + 2_000);
    const reacquired = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-second",
      initiatedByUserId: userId,
      runId: "run-second",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
      now: afterExpiry,
    });
    expect(reacquired.runId).toBe("run-second");
    await expect(
      isContextLeaseHeldByRun({ prisma, contextId, runId: "run-second", now: afterExpiry }),
    ).resolves.toBe(true);

    const expiredEvents = await prisma.contextLeaseEvent.findMany({
      where: { contextId, kind: "lease.expired" },
    });
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0]?.runId).toBe("run-crashed");
  });

  it("stops public-effect authority at expiry without cutting off the crashed run's ongoing read-only work", async () => {
    const { contextId, drawingId } = await newContext("split-frame");
    const now = new Date();
    const mount = await createAgentRunMount({
      prisma,
      drawingId,
      runId: "run-reading",
      displayName: "Reading agent",
      audience: { kind: "drawing" },
    });

    await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-reading",
      initiatedByUserId: userId,
      runId: "run-reading",
      ttlMs: 1_000,
      endHorizonAt: horizon(300_000),
      now,
    });

    // While the lease is live, the same run can both read and, in
    // principle, still act publicly (it holds the lease).
    const readWhileLive = await executeAgentBoardTool({
      prisma,
      drawingId,
      runId: mount.runId,
      capabilityToken: mount.capabilityToken,
      tool: "overview",
    });
    expect(readWhileLive.result).toBeDefined();
    await expect(
      isContextLeaseHeldByRun({ prisma, contextId, runId: "run-reading", now }),
    ).resolves.toBe(true);

    // Past expiry: public-effect authority is gone -- a fresh acquire by
    // this same run would now succeed only as a NEW grant, not a
    // continuation, and another orchestrator's acquire is no longer
    // refused. But its read-only exploration is completely untouched:
    // read tools never consult ContextLease at all, by construction.
    const afterExpiry = new Date(now.getTime() + 2_000);
    await expect(
      isContextLeaseHeldByRun({ prisma, contextId, runId: "run-reading", now: afterExpiry }),
    ).resolves.toBe(false);

    const readAfterExpiry = await executeAgentBoardTool({
      prisma,
      drawingId,
      runId: mount.runId,
      capabilityToken: mount.capabilityToken,
      tool: "overview",
    });
    expect(readAfterExpiry.result).toBeDefined();
    expect(readAfterExpiry.resultHash).toBe(readWhileLive.resultHash);

    // And the Context's public effect is now free for someone else.
    const other = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-other",
      initiatedByUserId: userId,
      runId: "run-other",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
      now: afterExpiry,
    });
    expect(other.runId).toBe("run-other");
  });

  it("logs a takeover visibly in the shared room, and denies transfer to anyone but the holder without an override", async () => {
    const { contextId } = await newContext("transfer-frame");
    const lease = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-a",
      initiatedByUserId: userId,
      runId: "run-a",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
    });

    // A different human, not the one who initiated the lease, cannot force
    // a takeover just by presenting the right leaseGeneration (public via
    // GET) without an override.
    await expect(
      transferContextLease({
        prisma,
        contextId,
        leaseGeneration: lease.leaseGeneration,
        callerUserId: otherUserId,
        toOrchestratorId: "orchestrator-b",
        toRunId: "run-b",
        toInitiatedByUserId: otherUserId,
        authorizedAsOverride: false,
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(ContextLeaseTransferDeniedError);
    await expect(isContextLeaseHeldByRun({ prisma, contextId, runId: "run-a" })).resolves.toBe(
      true,
    );

    // The lease's own initiator consents to the handoff.
    const transferred = await transferContextLease({
      prisma,
      contextId,
      leaseGeneration: lease.leaseGeneration,
      callerUserId: userId,
      toOrchestratorId: "orchestrator-b",
      toRunId: "run-b",
      toInitiatedByUserId: userId,
      authorizedAsOverride: false,
      ttlMs: 60_000,
    });
    expect(transferred.runId).toBe("run-b");
    // The horizon is carried over, not reset by the handoff.
    expect(transferred.endHorizonAt.getTime()).toBe(lease.endHorizonAt.getTime());

    const events = await prisma.contextLeaseEvent.findMany({
      where: { contextId, kind: "lease.transferred" },
    });
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload).toMatchObject({ fromRunId: "run-a", toRunId: "run-b", viaOverride: false });
  });

  it("denies release to a caller who is neither the lease's initiator nor an owner override, even knowing leaseGeneration and runId", async () => {
    const { contextId } = await newContext("release-auth-frame");
    const lease = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-a",
      initiatedByUserId: userId,
      runId: "run-a",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
    });

    // otherUserId has read the lease's leaseGeneration/runId (e.g. off the
    // GET endpoint) and tries to end it -- must fail, atomically, not as a
    // separate check the CAS could race past.
    await expect(
      releaseContextLease({
        prisma,
        contextId,
        leaseGeneration: lease.leaseGeneration,
        runId: "run-a",
        callerUserId: otherUserId,
        allowOwnerOverride: false,
      }),
    ).rejects.toBeInstanceOf(ContextLeaseNotHeldError);
    await expect(isContextLeaseHeldByRun({ prisma, contextId, runId: "run-a" })).resolves.toBe(
      true,
    );

    // An explicit owner override succeeds even though otherUserId never initiated it.
    await releaseContextLease({
      prisma,
      contextId,
      leaseGeneration: lease.leaseGeneration,
      runId: "run-a",
      callerUserId: otherUserId,
      allowOwnerOverride: true,
    });
    await expect(isContextLeaseHeldByRun({ prisma, contextId, runId: "run-a" })).resolves.toBe(
      false,
    );

    // And the lease's own initiator can release their own lease normally.
    const own = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-b",
      initiatedByUserId: userId,
      runId: "run-b",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
    });
    await releaseContextLease({
      prisma,
      contextId,
      leaseGeneration: own.leaseGeneration,
      runId: "run-b",
      callerUserId: userId,
      allowOwnerOverride: false,
    });
    await expect(isContextLeaseHeldByRun({ prisma, contextId, runId: "run-b" })).resolves.toBe(
      false,
    );
  });

  it("denies renew to a caller who is neither the lease's initiator nor an owner override", async () => {
    const { contextId } = await newContext("renew-auth-frame");
    const lease = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-a",
      initiatedByUserId: userId,
      runId: "run-a",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
    });

    await expect(
      renewContextLease({
        prisma,
        contextId,
        leaseGeneration: lease.leaseGeneration,
        runId: "run-a",
        callerUserId: otherUserId,
        allowOwnerOverride: false,
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(ContextLeaseTransferDeniedError);

    const renewed = await renewContextLease({
      prisma,
      contextId,
      leaseGeneration: lease.leaseGeneration,
      runId: "run-a",
      callerUserId: userId,
      allowOwnerOverride: false,
      ttlMs: 60_000,
    });
    expect(renewed.runId).toBe("run-a");
  });

  it("never renews past the human-approved end horizon", async () => {
    const { contextId } = await newContext("horizon-frame");
    const now = new Date();
    const endHorizonAt = new Date(now.getTime() + 5_000);
    const lease = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-a",
      initiatedByUserId: userId,
      runId: "run-a",
      ttlMs: 1_000,
      endHorizonAt,
      now,
    });
    expect(lease.expiresAt.getTime()).toBe(now.getTime() + 1_000);

    const renewed = await renewContextLease({
      prisma,
      contextId,
      leaseGeneration: lease.leaseGeneration,
      runId: "run-a",
      callerUserId: userId,
      allowOwnerOverride: false,
      ttlMs: 60_000, // far beyond the horizon
      now: new Date(now.getTime() + 500),
    });
    expect(renewed.expiresAt.getTime()).toBe(endHorizonAt.getTime());
  });

  it("rejects a renew from a run that no longer matches the current lease generation", async () => {
    const { contextId } = await newContext("stale-frame");
    const lease = await acquireContextLease({
      prisma,
      contextId,
      holderOrchestratorId: "orchestrator-a",
      initiatedByUserId: userId,
      runId: "run-a",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
    });
    await releaseContextLease({
      prisma,
      contextId,
      leaseGeneration: lease.leaseGeneration,
      runId: "run-a",
      callerUserId: userId,
      allowOwnerOverride: false,
    });
    await expect(
      renewContextLease({
        prisma,
        contextId,
        leaseGeneration: lease.leaseGeneration,
        runId: "run-a",
        callerUserId: userId,
        allowOwnerOverride: false,
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(ContextLeaseNotHeldError);
  });

  it("keeps a successfully granted lease intact even when appending its coordination-trace event fails", async () => {
    const { contextId } = await newContext("event-failure-frame");
    let failNextEventInsert = false;
    const flakyPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "contextLeaseEvent") {
          const real = Reflect.get(target, prop, receiver);
          return new Proxy(real, {
            get(eventTarget, eventProp, eventReceiver) {
              if (eventProp === "create") {
                return async (...args: unknown[]) => {
                  if (failNextEventInsert) {
                    failNextEventInsert = false;
                    throw new Error("simulated transient DB contention on event insert");
                  }
                  return (eventTarget as any).create(...args);
                };
              }
              return Reflect.get(eventTarget, eventProp, eventReceiver);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    failNextEventInsert = true;
    const lease = await acquireContextLease({
      prisma: flakyPrisma,
      contextId,
      holderOrchestratorId: "orchestrator-a",
      initiatedByUserId: userId,
      runId: "run-a",
      ttlMs: 60_000,
      endHorizonAt: horizon(300_000),
    });

    // The grant itself must not have thrown, and the database must agree
    // the lease is genuinely held -- a caller retrying after a false
    // failure here would otherwise collide with its own already-granted lease.
    expect(lease.runId).toBe("run-a");
    await expect(isContextLeaseHeldByRun({ prisma, contextId, runId: "run-a" })).resolves.toBe(
      true,
    );
    expect(failNextEventInsert).toBe(false);
  });
});
