import { canonicalJson, secretsEqual } from "./canonicalJson";

type PrismaLike = any;

export const DISPATCH_START_DEADLINE_MS = 30_000;
export const DISPATCH_LIVENESS_WINDOW_MS = 60_000;

export type DispatchExecutionStatus =
  | "queued"
  | "runtime_acknowledged"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export type DispatchEffectStatus =
  "not_requested" | "pending" | "committed" | "rejected" | "failed";

// Drawing-audience projection only. The persisted originThreadId and
// initiatedByUserId remain server-internal audit/authorization facts: a
// private thread address or account id is never public receipt metadata.
export type DispatchReceiptProjection = {
  id: string;
  drawingId: string;
  publicThreadId: string;
  originVisibility: "private" | "drawing";
  objectiveSummary: string;
  targetContextIds: string[];
  revisionId: string;
  effectiveCapabilities: string[];
  budget: Record<string, unknown>;
  expectedArtifacts: string[];
  runId: string;
  leases: Array<{ contextId: string; leaseGeneration: string }>;
  admission: "accepted" | "rejected";
  execution: DispatchExecutionStatus;
  effect: DispatchEffectStatus;
  acceptedAt: string;
  runtimeAcknowledgedAt: string | null;
  lastObservedAt: string | null;
  executionTerminalAt: string | null;
  effectTerminalAt: string | null;
  effectEvidence: Record<string, unknown> | null;
  startDeadlineAt: string;
  livenessDeadlineAt: string;
  effectDeadlineAt: string;
  updatedAt: string;
};

export class DispatchReceiptError extends Error {
  constructor(
    public readonly code:
      | "DISPATCH_INVALID"
      | "DISPATCH_NOT_FOUND"
      | "DISPATCH_LEASE_NOT_HELD"
      | "DISPATCH_EFFECT_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "DispatchReceiptError";
  }
}

const parseArray = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
};

const parseObject = (value: string | null): Record<string, unknown> | null => {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const receiptInclude = {
  leases: { select: { contextId: true, leaseGeneration: true }, orderBy: { contextId: "asc" } },
} as const;

const toReceipt = (row: any): DispatchReceiptProjection => ({
  id: row.id,
  drawingId: row.drawingId,
  publicThreadId: row.publicThreadId,
  originVisibility: row.originAudienceKind,
  objectiveSummary: row.objectiveSummary,
  targetContextIds: parseArray(row.targetContextIds),
  revisionId: row.revisionId,
  effectiveCapabilities: parseArray(row.effectiveCapabilities),
  budget: parseObject(row.budget) ?? {},
  expectedArtifacts: parseArray(row.expectedArtifacts),
  runId: row.runId,
  leases: row.leases,
  admission: row.admissionStatus,
  execution: row.executionStatus,
  effect: row.effectStatus,
  acceptedAt: row.createdAt.toISOString(),
  runtimeAcknowledgedAt: row.runtimeAcknowledgedAt?.toISOString() ?? null,
  lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
  executionTerminalAt: row.executionTerminalAt?.toISOString() ?? null,
  effectTerminalAt: row.effectTerminalAt?.toISOString() ?? null,
  effectEvidence: parseObject(row.effectEvidence),
  startDeadlineAt: row.startDeadlineAt.toISOString(),
  livenessDeadlineAt: row.livenessDeadlineAt.toISOString(),
  effectDeadlineAt: row.effectDeadlineAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const isExecutionTerminal = (status: string): boolean =>
  status === "succeeded" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "outcome_unknown";

const appendTransition = async (
  tx: PrismaLike,
  params: {
    dispatchId: string;
    from: readonly string[];
    executionStatus: DispatchExecutionStatus;
    kind: string;
    payload: Record<string, unknown>;
    data?: Record<string, unknown>;
    now: Date;
  },
): Promise<any | null> => {
  const updated = await tx.agentDispatchReceipt.updateMany({
    where: { id: params.dispatchId, executionStatus: { in: [...params.from] } },
    data: {
      executionStatus: params.executionStatus,
      nextEventSequence: { increment: 1 },
      updatedAt: params.now,
      ...params.data,
    },
  });
  if (updated.count !== 1) return null;
  const receipt = await tx.agentDispatchReceipt.findUniqueOrThrow({
    where: { id: params.dispatchId },
    include: receiptInclude,
  });
  await tx.agentDispatchReceiptEvent.create({
    data: {
      dispatchId: params.dispatchId,
      sequence: receipt.nextEventSequence,
      kind: params.kind,
      payload: canonicalJson(params.payload),
      createdAt: params.now,
    },
  });
  return receipt;
};

export const acceptDispatchReceipt = async (params: {
  prisma: PrismaLike;
  dispatchId: string;
  drawingId: string;
  originThreadId: string;
  publicThreadId: string;
  initiatedByUserId: string;
  objectiveSummary: string;
  targetContextIds: string[];
  revisionId: string;
  effectiveCapabilities: string[];
  budget: Record<string, unknown>;
  expectedArtifacts: string[];
  runId: string;
  leases: Array<{ contextId: string; leaseGeneration: string }>;
  runtimeRequest: {
    connectionId: string;
    profileId: string;
    displayName: string;
    mountCapabilityToken: string;
    allowedContextIds: string[];
  };
  effectDeadlineAt: Date;
  now?: Date;
}): Promise<DispatchReceiptProjection> => {
  const now = params.now ?? new Date();
  const targetContextIds = [...new Set(params.targetContextIds)].sort();
  if (targetContextIds.length === 0 || targetContextIds.length !== params.leases.length) {
    throw new DispatchReceiptError(
      "DISPATCH_INVALID",
      "Every public dispatch target needs one admitted Context Lease generation.",
    );
  }
  const startDeadlineAt = new Date(now.getTime() + DISPATCH_START_DEADLINE_MS);
  const livenessDeadlineAt = new Date(startDeadlineAt.getTime() + DISPATCH_LIVENESS_WINDOW_MS);
  const row = await params.prisma.$transaction(async (tx: PrismaLike) => {
    const [origin, publicThread, mount, contexts, liveLeases] = await Promise.all([
      tx.agentThread.findFirst({
        where: {
          id: params.originThreadId,
          drawingId: params.drawingId,
          threadKind: "orchestrator",
        },
      }),
      tx.agentThread.findFirst({
        where: {
          id: params.publicThreadId,
          drawingId: params.drawingId,
          threadKind: "orchestrator",
          audienceKind: "drawing",
          audienceUserId: null,
        },
      }),
      tx.agentRunMount.findFirst({
        where: { runId: params.runId, drawingId: params.drawingId, revisionId: params.revisionId },
      }),
      tx.agentContext.findMany({
        where: { drawingId: params.drawingId, id: { in: targetContextIds } },
        select: { id: true },
      }),
      tx.contextLease.findMany({
        where: { contextId: { in: targetContextIds }, runId: params.runId },
      }),
    ]);
    if (
      !origin ||
      (origin.audienceKind === "private" && origin.audienceUserId !== params.initiatedByUserId) ||
      !["private", "drawing"].includes(origin.audienceKind) ||
      !publicThread ||
      !mount ||
      mount.audienceKind !== "drawing" ||
      canonicalJson(parseArray(mount.allowedContextIds).sort()) !==
        canonicalJson(targetContextIds) ||
      canonicalJson([...new Set(params.runtimeRequest.allowedContextIds)].sort()) !==
        canonicalJson(targetContextIds) ||
      contexts.length !== targetContextIds.length
    ) {
      throw new DispatchReceiptError(
        "DISPATCH_INVALID",
        "Dispatch threads, mount, Contexts and drawing audience must already agree.",
      );
    }
    const admitted = new Map(
      params.leases.map((lease) => [lease.contextId, lease.leaseGeneration]),
    );
    if (
      liveLeases.length !== targetContextIds.length ||
      liveLeases.some(
        (lease: any) =>
          lease.releasedAt !== null ||
          lease.expiresAt.getTime() < now.getTime() ||
          admitted.get(lease.contextId) !== lease.leaseGeneration,
      )
    ) {
      throw new DispatchReceiptError(
        "DISPATCH_LEASE_NOT_HELD",
        "The dispatch no longer owns every admitted public-effect lease.",
      );
    }
    const created = await tx.agentDispatchReceipt.create({
      data: {
        id: params.dispatchId,
        drawingId: params.drawingId,
        originThreadId: params.originThreadId,
        publicThreadId: params.publicThreadId,
        originAudienceKind: origin.audienceKind,
        initiatedByUserId: params.initiatedByUserId,
        objectiveSummary: params.objectiveSummary,
        targetContextIds: canonicalJson(targetContextIds),
        revisionId: params.revisionId,
        effectiveCapabilities: canonicalJson([...new Set(params.effectiveCapabilities)].sort()),
        budget: canonicalJson(params.budget),
        expectedArtifacts: canonicalJson(params.expectedArtifacts),
        runId: params.runId,
        startDeadlineAt,
        livenessDeadlineAt,
        effectDeadlineAt: params.effectDeadlineAt,
        nextEventSequence: 1,
        leases: { create: params.leases },
        outbox: {
          create: { state: "pending", payload: canonicalJson(params.runtimeRequest) },
        },
        events: {
          create: {
            sequence: 1,
            kind: "dispatch.accepted",
            payload: canonicalJson({
              originVisibility: origin.audienceKind,
              targetContextIds,
              revisionId: params.revisionId,
              effectiveCapabilities: [...new Set(params.effectiveCapabilities)].sort(),
              expectedArtifacts: params.expectedArtifacts,
            }),
            createdAt: now,
          },
        },
      },
      include: receiptInclude,
    });
    return created;
  });
  return toReceipt(row);
};

export const listPublicDispatchReceipts = async (params: {
  prisma: PrismaLike;
  drawingId: string;
  publicThreadId: string;
}): Promise<DispatchReceiptProjection[]> => {
  const thread = await params.prisma.agentThread.findFirst({
    where: {
      id: params.publicThreadId,
      drawingId: params.drawingId,
      threadKind: "orchestrator",
      audienceKind: "drawing",
      audienceUserId: null,
    },
    select: { id: true },
  });
  if (!thread) throw new DispatchReceiptError("DISPATCH_NOT_FOUND", "Shared thread not found.");
  const rows = await params.prisma.agentDispatchReceipt.findMany({
    where: { drawingId: params.drawingId, publicThreadId: params.publicThreadId },
    include: receiptInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toReceipt);
};

/**
 * Restores only the server-side reconciliation schedule after a process
 * restart. Calling the outbox worker for every returned receipt is safe:
 * `pending` can still be claimed once, while `sending` and completed rows are
 * deliberately not claimable and therefore can never duplicate a foreign
 * runtime start.
 */
export const listUnresolvedDispatchReceipts = async (params: {
  prisma: PrismaLike;
}): Promise<DispatchReceiptProjection[]> => {
  const rows = await params.prisma.agentDispatchReceipt.findMany({
    where: {
      OR: [
        {
          executionStatus: {
            in: ["queued", "runtime_acknowledged", "running", "blocked"],
          },
        },
        { effectStatus: "pending" },
      ],
    },
    include: receiptInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toReceipt);
};

/** Claim once before the foreign call. A stale `sending` row is never retried. */
export const claimDispatchOutbox = async (params: {
  prisma: PrismaLike;
  dispatchId: string;
  now?: Date;
}): Promise<boolean> => {
  const now = params.now ?? new Date();
  const claimed = await params.prisma.agentDispatchOutbox.updateMany({
    where: { dispatchId: params.dispatchId, state: "pending" },
    data: { state: "sending", attemptStartedAt: now, updatedAt: now },
  });
  return claimed.count === 1;
};

export const acknowledgeDispatchRuntime = async (params: {
  prisma: PrismaLike;
  dispatchId: string;
  runtimeCapability: string;
  runtimeStatus: "working" | "idle" | "blocked" | "done" | "unknown";
  now?: Date;
}): Promise<DispatchReceiptProjection | null> => {
  const now = params.now ?? new Date();
  const mapped: DispatchExecutionStatus =
    params.runtimeStatus === "done"
      ? "succeeded"
      : params.runtimeStatus === "unknown"
        ? "outcome_unknown"
        : "runtime_acknowledged";
  const row = await params.prisma.$transaction(async (tx: PrismaLike) => {
    const receipt = await appendTransition(tx, {
      dispatchId: params.dispatchId,
      from: ["queued"],
      executionStatus: mapped,
      kind: "runtime.acknowledged",
      payload: { status: mapped },
      data: {
        runtimeCapability: params.runtimeCapability,
        runtimeAcknowledgedAt: now,
        lastObservedAt: now,
        livenessDeadlineAt: new Date(now.getTime() + DISPATCH_LIVENESS_WINDOW_MS),
        ...(isExecutionTerminal(mapped) ? { executionTerminalAt: now } : {}),
      },
      now,
    });
    if (!receipt) return null;
    await tx.agentDispatchOutbox.updateMany({
      where: { dispatchId: params.dispatchId, state: "sending" },
      data: { state: "completed", payload: null, completedAt: now, updatedAt: now },
    });
    if (mapped === "outcome_unknown") {
      await releaseReceiptLeases(tx, params.dispatchId, now);
    }
    return receipt;
  });
  return row ? toReceipt(row) : null;
};

export const failDispatchBeforeRuntimeAck = async (params: {
  prisma: PrismaLike;
  dispatchId: string;
  reasonCode: string;
  now?: Date;
}): Promise<DispatchReceiptProjection | null> => {
  const now = params.now ?? new Date();
  const row = await params.prisma.$transaction(async (tx: PrismaLike) => {
    const receipt = await appendTransition(tx, {
      dispatchId: params.dispatchId,
      from: ["queued"],
      executionStatus: "failed",
      kind: "runtime.failed",
      payload: { reasonCode: params.reasonCode },
      data: { executionTerminalAt: now, effectStatus: "failed", effectTerminalAt: now },
      now,
    });
    if (!receipt) return null;
    await tx.agentDispatchOutbox.updateMany({
      where: { dispatchId: params.dispatchId, state: { in: ["pending", "sending"] } },
      data: { state: "failed", payload: null, completedAt: now, updatedAt: now },
    });
    await releaseReceiptLeases(tx, params.dispatchId, now);
    return receipt;
  });
  return row ? toReceipt(row) : null;
};

export const observeDispatchRuntime = async (params: {
  prisma: PrismaLike;
  dispatchId: string;
  runtimeStatus: "working" | "idle" | "blocked" | "done" | "unknown";
  now?: Date;
}): Promise<DispatchReceiptProjection | null> => {
  const now = params.now ?? new Date();
  const mapped: DispatchExecutionStatus =
    params.runtimeStatus === "done"
      ? "succeeded"
      : params.runtimeStatus === "unknown"
        ? "outcome_unknown"
        : params.runtimeStatus === "blocked"
          ? "blocked"
          : "running";
  const row = await params.prisma.$transaction(async (tx: PrismaLike) => {
    const receipt = await appendTransition(tx, {
      dispatchId: params.dispatchId,
      from: ["runtime_acknowledged", "running", "blocked"],
      executionStatus: mapped,
      kind: `runtime.${mapped}`,
      payload: { status: mapped },
      data: {
        lastObservedAt: now,
        livenessDeadlineAt: new Date(now.getTime() + DISPATCH_LIVENESS_WINDOW_MS),
        ...(isExecutionTerminal(mapped) ? { executionTerminalAt: now } : {}),
      },
      now,
    });
    if (receipt && mapped === "outcome_unknown") {
      await releaseReceiptLeases(tx, params.dispatchId, now);
    }
    return receipt;
  });
  return row ? toReceipt(row) : null;
};

const releaseReceiptLeases = async (tx: PrismaLike, dispatchId: string, now: Date) => {
  const bindings = await tx.agentDispatchLease.findMany({ where: { dispatchId } });
  for (const binding of bindings.sort((a: any, b: any) => a.contextId.localeCompare(b.contextId))) {
    await tx.contextLease.updateMany({
      where: {
        contextId: binding.contextId,
        leaseGeneration: binding.leaseGeneration,
        releasedAt: null,
      },
      data: { releasedAt: now, updatedAt: now },
    });
  }
};

/**
 * Server-clock reconciliation. Silence proves neither failure nor success:
 * once a bounded observation window closes it becomes `outcome_unknown`.
 */
export const reconcileDispatchReceipt = async (params: {
  prisma: PrismaLike;
  dispatchId: string;
  now?: Date;
}): Promise<DispatchReceiptProjection | null> => {
  const now = params.now ?? new Date();
  return params.prisma.$transaction(async (tx: PrismaLike) => {
    const current = await tx.agentDispatchReceipt.findUnique({
      where: { id: params.dispatchId },
      include: receiptInclude,
    });
    if (!current) return null;
    let row: any | null = null;
    if (
      current.executionStatus === "queued" &&
      current.startDeadlineAt.getTime() <= now.getTime()
    ) {
      row = await appendTransition(tx, {
        dispatchId: params.dispatchId,
        from: ["queued"],
        executionStatus: "outcome_unknown",
        kind: "runtime.outcome_unknown",
        payload: { reasonCode: "START_ACK_DEADLINE_ELAPSED" },
        data: { executionTerminalAt: now },
        now,
      });
      await tx.agentDispatchOutbox.updateMany({
        where: { dispatchId: params.dispatchId, state: { in: ["pending", "sending"] } },
        data: {
          state: "outcome_unknown",
          payload: null,
          completedAt: now,
          updatedAt: now,
        },
      });
    } else if (
      ["runtime_acknowledged", "running", "blocked"].includes(current.executionStatus) &&
      current.livenessDeadlineAt.getTime() <= now.getTime()
    ) {
      row = await appendTransition(tx, {
        dispatchId: params.dispatchId,
        from: ["runtime_acknowledged", "running", "blocked"],
        executionStatus: "outcome_unknown",
        kind: "runtime.outcome_unknown",
        payload: { reasonCode: "LIVENESS_DEADLINE_ELAPSED" },
        data: { executionTerminalAt: now },
        now,
      });
    }
    if (row?.executionStatus === "outcome_unknown")
      await releaseReceiptLeases(tx, params.dispatchId, now);

    const effectBase = row ?? current;
    if (
      effectBase.effectStatus === "pending" &&
      effectBase.effectDeadlineAt.getTime() <= now.getTime()
    ) {
      const effectUpdated = await tx.agentDispatchReceipt.updateMany({
        where: { id: params.dispatchId, effectStatus: "pending" },
        data: {
          effectStatus: "failed",
          effectTerminalAt: now,
          nextEventSequence: { increment: 1 },
          updatedAt: now,
        },
      });
      if (effectUpdated.count === 1) {
        const withSequence = await tx.agentDispatchReceipt.findUniqueOrThrow({
          where: { id: params.dispatchId },
          include: receiptInclude,
        });
        await tx.agentDispatchReceiptEvent.create({
          data: {
            dispatchId: params.dispatchId,
            sequence: withSequence.nextEventSequence,
            kind: "effect.failed",
            payload: canonicalJson({ reasonCode: "EFFECT_DEADLINE_ELAPSED" }),
            createdAt: now,
          },
        });
        await releaseReceiptLeases(tx, params.dispatchId, now);
        row = withSequence;
      }
    }
    const finalRow = row
      ? await tx.agentDispatchReceipt.findUniqueOrThrow({
          where: { id: params.dispatchId },
          include: receiptInclude,
        })
      : current;
    return toReceipt(finalRow);
  });
};

/**
 * Called INSIDE the authoritative drawing-write transaction after its version
 * update. Every Lease row is CAS-touched in deterministic order, so transfer,
 * release or expiry/re-acquire cannot slip between the authority check and the
 * write whose effect this receipt claims.
 */
export const commitDispatchBoardEffect = async (params: {
  tx: PrismaLike;
  drawingId: string;
  dispatchId: string;
  runId: string;
  mountCapabilityToken: string;
  drawingVersion: number;
  now?: Date;
}): Promise<DispatchReceiptProjection> => {
  const now = params.now ?? new Date();
  const receipt = await params.tx.agentDispatchReceipt.findFirst({
    where: {
      id: params.dispatchId,
      drawingId: params.drawingId,
      runId: params.runId,
      effectStatus: "pending",
    },
    include: { ...receiptInclude, mount: true },
  });
  if (!receipt || !secretsEqual(params.mountCapabilityToken, receipt.mount.capabilityTokenHash)) {
    throw new DispatchReceiptError(
      "DISPATCH_EFFECT_NOT_ALLOWED",
      "The write is not bound to this dispatch's mounted run.",
    );
  }
  for (const binding of [...receipt.leases].sort((a, b) =>
    a.contextId.localeCompare(b.contextId),
  )) {
    const locked = await params.tx.contextLease.updateMany({
      where: {
        contextId: binding.contextId,
        leaseGeneration: binding.leaseGeneration,
        runId: params.runId,
        releasedAt: null,
        expiresAt: { gte: now },
      },
      // A guarded no-op-style touch both proves and locks this generation in
      // the same transaction as the drawing mutation.
      data: { updatedAt: now },
    });
    if (locked.count !== 1) {
      throw new DispatchReceiptError(
        "DISPATCH_LEASE_NOT_HELD",
        "The mounted run no longer holds every public-effect lease.",
      );
    }
  }
  const evidence = {
    kind: "drawing.version",
    drawingId: params.drawingId,
    version: params.drawingVersion,
  };
  const updated = await params.tx.agentDispatchReceipt.updateMany({
    where: { id: params.dispatchId, effectStatus: "pending" },
    data: {
      effectStatus: "committed",
      effectTerminalAt: now,
      effectEvidence: canonicalJson(evidence),
      nextEventSequence: { increment: 1 },
      updatedAt: now,
    },
  });
  if (updated.count !== 1) {
    throw new DispatchReceiptError(
      "DISPATCH_EFFECT_NOT_ALLOWED",
      "The dispatch effect was already resolved.",
    );
  }
  const result = await params.tx.agentDispatchReceipt.findUniqueOrThrow({
    where: { id: params.dispatchId },
    include: receiptInclude,
  });
  await params.tx.agentDispatchReceiptEvent.create({
    data: {
      dispatchId: params.dispatchId,
      sequence: result.nextEventSequence,
      kind: "effect.committed",
      payload: canonicalJson(evidence),
      createdAt: now,
    },
  });
  await releaseReceiptLeases(params.tx, params.dispatchId, now);
  return toReceipt(result);
};

export const loadDispatchForWorker = async (params: {
  prisma: PrismaLike;
  dispatchId: string;
}): Promise<any | null> =>
  params.prisma.agentDispatchReceipt.findUnique({
    where: { id: params.dispatchId },
    include: { leases: true, outbox: true },
  });
