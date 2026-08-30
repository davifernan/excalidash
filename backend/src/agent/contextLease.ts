import { randomUUID } from "crypto";

/**
 * NIL-680. Exclusivity primitive for a Context's PUBLIC effect, not for
 * reading it. Any number of read-only runs may explore a Context in
 * parallel and prepare private drafts -- none of that needs a lease. A
 * Lease answers exactly one question: which run may currently cause a
 * shared, board-visible effect (a dispatch, a publish, a write) through
 * this Context. There is one `ContextLease` row per Context, created once
 * and then atomically reused for every later acquire.
 *
 * The CAS is a single guarded `updateMany`. Prisma compiles that to one SQL
 * UPDATE statement with a WHERE clause, which both SQLite and PostgreSQL
 * execute atomically -- no explicit row lock or `$transaction` is needed for
 * the winner-take-one guarantee itself: at most one concurrent `updateMany`
 * with the same guard can match and mutate the row, full stop.
 *
 * `leaseGeneration` is the opaque token a caller must present back to renew,
 * transfer, or release -- proof it still addresses the lease it thinks it
 * holds, not a stale or already-superseded one. It is not a secret; it is a
 * compare key, the same role `revision` fields play elsewhere in this repo.
 *
 * `endHorizonAt` is never decided here. It must arrive from the caller as
 * the outer bound a human already approved for this dispatch -- this module
 * enforces that no acquire, renew, or transfer ever produces an `expiresAt`
 * past it, but it does not choose or extend it itself (see NIL-680's own
 * recon: "Dieser Maximalhorizont ist nicht durch Heartbeats verschiebbar").
 */

type PrismaLike = any;

export type ContextLeaseSnapshot = {
  contextId: string;
  leaseGeneration: string;
  holderOrchestratorId: string;
  initiatedByUserId: string;
  runId: string;
  acquiredAt: Date;
  expiresAt: Date;
  endHorizonAt: Date;
};

export class ContextLeaseHeldError extends Error {
  constructor(public readonly heldBy: ContextLeaseSnapshot) {
    super(
      `Context ${heldBy.contextId} already has an active public-effect lease held by run ${heldBy.runId}, expiring ${heldBy.expiresAt.toISOString()}.`,
    );
    this.name = "ContextLeaseHeldError";
  }
}

export class ContextLeaseNotHeldError extends Error {
  constructor(
    public readonly contextId: string,
    reason: string,
  ) {
    super(`No matching active lease for Context ${contextId}: ${reason}`);
    this.name = "ContextLeaseNotHeldError";
  }
}

export class ContextLeaseTransferDeniedError extends Error {
  constructor(contextId: string) {
    super(
      `Context ${contextId}'s lease may only be transferred by its current holder or an explicit privileged override.`,
    );
    this.name = "ContextLeaseTransferDeniedError";
  }
}

const toSnapshot = (row: {
  contextId: string;
  leaseGeneration: string;
  holderOrchestratorId: string;
  initiatedByUserId: string;
  runId: string;
  acquiredAt: Date;
  expiresAt: Date;
  endHorizonAt: Date;
}): ContextLeaseSnapshot => ({
  contextId: row.contextId,
  leaseGeneration: row.leaseGeneration,
  holderOrchestratorId: row.holderOrchestratorId,
  initiatedByUserId: row.initiatedByUserId,
  runId: row.runId,
  acquiredAt: row.acquiredAt,
  expiresAt: row.expiresAt,
  endHorizonAt: row.endHorizonAt,
});

const isLive = (row: { releasedAt: Date | null; expiresAt: Date }, now: Date): boolean =>
  row.releasedAt === null && row.expiresAt.getTime() >= now.getTime();

/** Best-effort log line to the Context's own coordination trace. Never the source of correctness -- the CAS above already decided the outcome before this is called. */
const logLeaseEvent = (
  prisma: PrismaLike,
  params: {
    contextId: string;
    kind: string;
    holderOrchestratorId?: string | null;
    initiatedByUserId?: string | null;
    runId?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<unknown> =>
  prisma.contextLeaseEvent.create({
    data: {
      contextId: params.contextId,
      kind: params.kind,
      holderOrchestratorId: params.holderOrchestratorId ?? null,
      initiatedByUserId: params.initiatedByUserId ?? null,
      runId: params.runId ?? null,
      payload: JSON.stringify(params.payload),
    },
  });

/**
 * Acquire the public-effect lease for a Context. Succeeds when no lease
 * row exists yet, or the existing one is released or expired. Fails with
 * `ContextLeaseHeldError` -- the visible "busy" outcome -- when another run
 * genuinely still holds it.
 */
export const acquireContextLease = async (params: {
  prisma: PrismaLike;
  contextId: string;
  holderOrchestratorId: string;
  initiatedByUserId: string;
  runId: string;
  ttlMs: number;
  endHorizonAt: Date;
  now?: Date;
}): Promise<ContextLeaseSnapshot> => {
  const now = params.now ?? new Date();
  if (params.endHorizonAt.getTime() <= now.getTime()) {
    throw new ContextLeaseNotHeldError(
      params.contextId,
      "endHorizonAt must be in the future; a lease cannot be acquired against an already-elapsed human approval window.",
    );
  }
  const expiresAt = new Date(Math.min(now.getTime() + params.ttlMs, params.endHorizonAt.getTime()));
  const leaseGeneration = randomUUID();
  const grantFields = {
    leaseGeneration,
    holderOrchestratorId: params.holderOrchestratorId,
    initiatedByUserId: params.initiatedByUserId,
    runId: params.runId,
    acquiredAt: now,
    expiresAt,
    endHorizonAt: params.endHorizonAt,
    updatedAt: now,
  };

  try {
    const created = await params.prisma.contextLease.create({
      data: { contextId: params.contextId, ...grantFields },
    });
    await logLeaseEvent(params.prisma, {
      contextId: params.contextId,
      kind: "lease.granted",
      holderOrchestratorId: params.holderOrchestratorId,
      initiatedByUserId: params.initiatedByUserId,
      runId: params.runId,
      payload: { leaseGeneration, expiresAt: expiresAt.toISOString(), previousState: "none" },
    });
    return toSnapshot(created);
  } catch (error) {
    // P2002: unique constraint on contextId -- a row already exists for this
    // Context. That is the ordinary case after the first-ever acquire; fall
    // through to the CAS re-grant path below rather than treating it as an
    // error.
    if (!(error instanceof Error) || !("code" in error) || (error as any).code !== "P2002") {
      throw error;
    }
  }

  const before = await params.prisma.contextLease.findUnique({
    where: { contextId: params.contextId },
  });
  const previousState =
    before && !isLive(before, now) ? (before.releasedAt ? "released" : "expired") : "none";

  const cas = await params.prisma.contextLease.updateMany({
    where: {
      contextId: params.contextId,
      OR: [{ releasedAt: { not: null } }, { expiresAt: { lt: now } }],
    },
    data: grantFields,
  });

  if (cas.count === 1) {
    await logLeaseEvent(params.prisma, {
      contextId: params.contextId,
      kind: "lease.granted",
      holderOrchestratorId: params.holderOrchestratorId,
      initiatedByUserId: params.initiatedByUserId,
      runId: params.runId,
      payload: { leaseGeneration, expiresAt: expiresAt.toISOString(), previousState },
    });
    if (previousState === "expired") {
      await logLeaseEvent(params.prisma, {
        contextId: params.contextId,
        kind: "lease.expired",
        holderOrchestratorId: before?.holderOrchestratorId ?? null,
        runId: before?.runId ?? null,
        payload: { leaseGeneration: before?.leaseGeneration ?? null },
      });
    }
    const row = await params.prisma.contextLease.findUniqueOrThrow({
      where: { contextId: params.contextId },
    });
    return toSnapshot(row);
  }

  // Lost the CAS: someone else holds a live lease right now. Read it back
  // for the busy signal and log the rejected attempt where the shared room
  // can see it.
  const holder = await params.prisma.contextLease.findUniqueOrThrow({
    where: { contextId: params.contextId },
  });
  await logLeaseEvent(params.prisma, {
    contextId: params.contextId,
    kind: "context.busy",
    holderOrchestratorId: params.holderOrchestratorId,
    initiatedByUserId: params.initiatedByUserId,
    runId: params.runId,
    payload: {
      requestedRunId: params.runId,
      heldByRunId: holder.runId,
      heldByOrchestratorId: holder.holderOrchestratorId,
      expiresAt: holder.expiresAt.toISOString(),
    },
  });
  throw new ContextLeaseHeldError(toSnapshot(holder));
};

/**
 * Extend liveness only. Only the run named on the current lease generation
 * may renew it, and the result can never move past `endHorizonAt` -- renewal
 * keeps a run alive, it does not re-open its authorization window.
 */
export const renewContextLease = async (params: {
  prisma: PrismaLike;
  contextId: string;
  leaseGeneration: string;
  runId: string;
  ttlMs: number;
  now?: Date;
}): Promise<ContextLeaseSnapshot> => {
  const now = params.now ?? new Date();
  const current = await params.prisma.contextLease.findUnique({
    where: { contextId: params.contextId },
  });
  if (
    !current ||
    current.leaseGeneration !== params.leaseGeneration ||
    current.runId !== params.runId
  ) {
    throw new ContextLeaseNotHeldError(
      params.contextId,
      "lease generation or run id does not match",
    );
  }
  if (!isLive(current, now)) {
    throw new ContextLeaseNotHeldError(params.contextId, "lease is released or already expired");
  }
  const proposedExpiresAt = new Date(now.getTime() + params.ttlMs);
  const newExpiresAt = new Date(
    Math.min(proposedExpiresAt.getTime(), current.endHorizonAt.getTime()),
  );
  const cas = await params.prisma.contextLease.updateMany({
    where: {
      contextId: params.contextId,
      leaseGeneration: params.leaseGeneration,
      runId: params.runId,
      releasedAt: null,
      expiresAt: { gte: now },
    },
    data: { expiresAt: newExpiresAt, updatedAt: now },
  });
  if (cas.count !== 1) {
    throw new ContextLeaseNotHeldError(params.contextId, "lease changed between read and renew");
  }
  const row = await params.prisma.contextLease.findUniqueOrThrow({
    where: { contextId: params.contextId },
  });
  return toSnapshot(row);
};

/**
 * Explicit handoff. `authorizedAsOverride` must be set by the caller only
 * after it has independently verified a privileged human override -- this
 * module has no opinion on who qualifies, the same boundary
 * `boardContexts.ts` draws for its own authorization-stays-at-the-route
 * convention. Without it, only the run currently named on the lease may
 * transfer it (the holder's own consent path). The end horizon is carried
 * over unchanged: a transfer moves who may act, never how long anyone may.
 */
export const transferContextLease = async (params: {
  prisma: PrismaLike;
  contextId: string;
  leaseGeneration: string;
  fromRunId: string;
  toOrchestratorId: string;
  toRunId: string;
  toInitiatedByUserId: string;
  authorizedAsOverride: boolean;
  ttlMs: number;
  now?: Date;
}): Promise<ContextLeaseSnapshot> => {
  const now = params.now ?? new Date();
  const current = await params.prisma.contextLease.findUnique({
    where: { contextId: params.contextId },
  });
  if (!current || current.leaseGeneration !== params.leaseGeneration || !isLive(current, now)) {
    throw new ContextLeaseNotHeldError(
      params.contextId,
      "lease generation does not match a live lease",
    );
  }
  if (current.runId !== params.fromRunId && !params.authorizedAsOverride) {
    throw new ContextLeaseTransferDeniedError(params.contextId);
  }
  const newGeneration = randomUUID();
  const newExpiresAt = new Date(
    Math.min(now.getTime() + params.ttlMs, current.endHorizonAt.getTime()),
  );
  const cas = await params.prisma.contextLease.updateMany({
    where: {
      contextId: params.contextId,
      leaseGeneration: params.leaseGeneration,
      releasedAt: null,
      expiresAt: { gte: now },
    },
    data: {
      leaseGeneration: newGeneration,
      holderOrchestratorId: params.toOrchestratorId,
      runId: params.toRunId,
      initiatedByUserId: params.toInitiatedByUserId,
      acquiredAt: now,
      expiresAt: newExpiresAt,
      updatedAt: now,
    },
  });
  if (cas.count !== 1) {
    throw new ContextLeaseNotHeldError(params.contextId, "lease changed between read and transfer");
  }
  await logLeaseEvent(params.prisma, {
    contextId: params.contextId,
    kind: "lease.transferred",
    holderOrchestratorId: params.toOrchestratorId,
    initiatedByUserId: params.toInitiatedByUserId,
    runId: params.toRunId,
    payload: {
      fromOrchestratorId: current.holderOrchestratorId,
      fromRunId: current.runId,
      toOrchestratorId: params.toOrchestratorId,
      toRunId: params.toRunId,
      viaOverride: params.authorizedAsOverride,
      leaseGeneration: newGeneration,
      expiresAt: newExpiresAt.toISOString(),
    },
  });
  const row = await params.prisma.contextLease.findUniqueOrThrow({
    where: { contextId: params.contextId },
  });
  return toSnapshot(row);
};

/** Explicit release -- the ordinary end of a run, not a crash. */
export const releaseContextLease = async (params: {
  prisma: PrismaLike;
  contextId: string;
  leaseGeneration: string;
  runId: string;
  now?: Date;
}): Promise<void> => {
  const now = params.now ?? new Date();
  const cas = await params.prisma.contextLease.updateMany({
    where: {
      contextId: params.contextId,
      leaseGeneration: params.leaseGeneration,
      runId: params.runId,
      releasedAt: null,
    },
    data: { releasedAt: now, updatedAt: now },
  });
  if (cas.count !== 1) {
    throw new ContextLeaseNotHeldError(
      params.contextId,
      "lease generation or run id does not match a held lease",
    );
  }
  await logLeaseEvent(params.prisma, {
    contextId: params.contextId,
    kind: "lease.released",
    runId: params.runId,
    payload: { leaseGeneration: params.leaseGeneration },
  });
};

/** Read-only check: does `runId` currently hold the live lease for this Context? Never mutates -- callers that need to act on the answer call acquire/renew themselves. */
export const isContextLeaseHeldByRun = async (params: {
  prisma: PrismaLike;
  contextId: string;
  runId: string;
  now?: Date;
}): Promise<boolean> => {
  const now = params.now ?? new Date();
  const current = await params.prisma.contextLease.findUnique({
    where: { contextId: params.contextId },
  });
  return !!current && current.runId === params.runId && isLive(current, now);
};
