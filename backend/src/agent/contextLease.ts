import { randomUUID } from "crypto";
import { logger } from "../logger";

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
 * holds, not a stale or already-superseded one. It is NOT a proof of
 * identity: `renew`/`transfer`/`release` each also take `callerUserId` and
 * fold it into the SAME guarded `updateMany`'s WHERE clause, atomically with
 * the CAS itself, not as a separate check before or after it. Only the
 * lease's own `initiatedByUserId`, or an explicit `allowOwnerOverride` the
 * ROUTE alone decides, may act on it -- `leaseGeneration`/`runId` leaking to
 * any board viewer (they must, so a client can address the lease it sees)
 * must never be sufficient on their own to end or extend someone else's
 * exclusivity.
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
      `Context ${contextId}'s lease may only be acted on by its own initiator or an explicit privileged override.`,
    );
    this.name = "ContextLeaseTransferDeniedError";
  }
}

/**
 * Distinct from `ContextLeaseNotHeldError`: this is a rejected REQUEST (bad
 * input), not a CAS that lost against real database state. A caller-facing
 * route must be able to tell "your `endHorizonAt` is invalid" (400) apart
 * from "someone else holds this now, or your compare key is stale" (409) --
 * conflating the two here would make both look like the same ordinary
 * conflict at the HTTP layer.
 */
export class ContextLeaseInvalidRequestError extends Error {
  constructor(
    public readonly contextId: string,
    reason: string,
  ) {
    super(`Invalid Context Lease request for ${contextId}: ${reason}`);
    this.name = "ContextLeaseInvalidRequestError";
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

/**
 * Best-effort log line to the Context's own coordination trace. Never the
 * source of correctness -- the CAS above already decided and PERSISTED the
 * outcome before this is called. A failure here (a transient DB hiccup, the
 * exact kind of contention `Promise.allSettled` races produce) must never
 * make an already-committed grant/renew/transfer/release look like it
 * failed to the caller -- that would split what the database believes from
 * what the caller believes about the same lease. Swallowed and logged, not
 * rethrown.
 */
const logLeaseEvent = async (
  prisma: PrismaLike,
  params: {
    contextId: string;
    kind: string;
    holderOrchestratorId?: string | null;
    initiatedByUserId?: string | null;
    runId?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> => {
  try {
    await prisma.contextLeaseEvent.create({
      data: {
        contextId: params.contextId,
        kind: params.kind,
        holderOrchestratorId: params.holderOrchestratorId ?? null,
        initiatedByUserId: params.initiatedByUserId ?? null,
        runId: params.runId ?? null,
        payload: JSON.stringify(params.payload),
      },
    });
  } catch (error) {
    logger.error("NIL-680: failed to append ContextLeaseEvent after an already-committed CAS", {
      contextId: params.contextId,
      kind: params.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Acquire the public-effect lease for a Context. Succeeds when no lease
 * row exists yet, or the existing one is released or expired. Fails with
 * `ContextLeaseHeldError` -- the visible "busy" outcome -- when another run
 * genuinely still holds it. No identity check: acquiring a FREE Context is
 * not acting on anyone else's lease.
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
    throw new ContextLeaseInvalidRequestError(
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
    // Explicit, not just "absent from `data`": the re-grant CAS below
    // reuses this same object to overwrite a row that may carry a real
    // timestamp here from a PRIOR explicit release. Without clearing it,
    // a released-then-reacquired Context would silently stay `isLive() ===
    // false` forever -- caught by this module's own release-then-reacquire
    // test, not by the earlier expiry-only reacquire test, since expiry
    // never sets `releasedAt` in the first place.
    releasedAt: null,
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
 * Extend liveness only. `callerUserId` must match the lease's own
 * `initiatedByUserId`, unless `allowOwnerOverride` is true -- and that
 * identity check is folded into the SAME `updateMany` WHERE as the
 * generation/run/liveness guard, atomically with the CAS, not as a
 * standalone check a stale read could be tricked past. The result can
 * never move past `endHorizonAt` -- renewal keeps a run alive, it does not
 * re-open its authorization window.
 */
export const renewContextLease = async (params: {
  prisma: PrismaLike;
  contextId: string;
  leaseGeneration: string;
  runId: string;
  callerUserId: string;
  allowOwnerOverride: boolean;
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
  if (current.initiatedByUserId !== params.callerUserId && !params.allowOwnerOverride) {
    throw new ContextLeaseTransferDeniedError(params.contextId);
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
      ...(params.allowOwnerOverride ? {} : { initiatedByUserId: params.callerUserId }),
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
 * Explicit handoff. `callerUserId` must match the lease's own
 * `initiatedByUserId` -- true consent from the human who currently holds
 * it -- unless `authorizedAsOverride` is true, which the ROUTE alone may
 * set, only after it has independently verified a privileged human
 * override (the same authorization-stays-at-the-caller boundary
 * `boardContexts.ts` draws for itself). Both the generation/liveness guard
 * AND the identity guard live in the SAME `updateMany` WHERE clause -- a
 * stale read between the check and the write can never grant an
 * unauthorized transfer, because the write itself re-checks everything.
 * The end horizon is carried over unchanged: a transfer moves who may act,
 * never how long anyone may.
 */
export const transferContextLease = async (params: {
  prisma: PrismaLike;
  contextId: string;
  leaseGeneration: string;
  callerUserId: string;
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
  if (current.initiatedByUserId !== params.callerUserId && !params.authorizedAsOverride) {
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
      ...(params.authorizedAsOverride ? {} : { initiatedByUserId: params.callerUserId }),
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

/**
 * Explicit release -- the ordinary end of a run, not a crash.
 * `callerUserId` must match the lease's own `initiatedByUserId`, unless
 * `allowOwnerOverride` is true; folded into the same guarded `updateMany`
 * as the generation/run guard, atomically. Without this, any board editor
 * who can read `leaseGeneration`/`runId` off the GET endpoint could end
 * someone else's lease -- exclusivity would be a convention, not an
 * enforced guarantee.
 */
export const releaseContextLease = async (params: {
  prisma: PrismaLike;
  contextId: string;
  leaseGeneration: string;
  runId: string;
  callerUserId: string;
  allowOwnerOverride: boolean;
  now?: Date;
}): Promise<void> => {
  const now = params.now ?? new Date();
  const cas = await params.prisma.contextLease.updateMany({
    where: {
      contextId: params.contextId,
      leaseGeneration: params.leaseGeneration,
      runId: params.runId,
      releasedAt: null,
      ...(params.allowOwnerOverride ? {} : { initiatedByUserId: params.callerUserId }),
    },
    data: { releasedAt: now, updatedAt: now },
  });
  if (cas.count !== 1) {
    throw new ContextLeaseNotHeldError(
      params.contextId,
      "lease generation/run id does not match a held lease this caller may release",
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
