import { canonicalJson } from "./canonicalJson";

const ACTORS = ["user", "agent", "system"] as const;
const EVENTS = ["message", "tool", "status", "artifact", "dispatch"] as const;

type ActorKind = (typeof ACTORS)[number];
type EventKind = (typeof EVENTS)[number];

export type ContextThreadEntry = {
  id: string;
  contextId: string;
  sequence: number;
  actor: { kind: ActorKind; id: string | null; displayName: string };
  kind: EventKind;
  payload: Record<string, unknown>;
  createdAt: string;
};

export class ContextThreadError extends Error {
  constructor(
    public readonly code: "CONTEXT_NOT_FOUND" | "INVALID_CONTEXT_EVENT",
    message: string,
  ) {
    super(message);
    this.name = "ContextThreadError";
  }
}

const parsePayload = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const toEntry = (row: any): ContextThreadEntry => ({
  id: row.id,
  contextId: row.contextId,
  sequence: row.sequence,
  actor: {
    kind: ACTORS.includes(row.actorKind) ? row.actorKind : "system",
    id: typeof row.actorId === "string" ? row.actorId : null,
    displayName: row.actorDisplayName,
  },
  kind: EVENTS.includes(row.eventKind) ? row.eventKind : "status",
  payload: parsePayload(row.payload),
  createdAt: row.createdAt.toISOString(),
});

const validatePayload = (kind: EventKind, payload: Record<string, unknown>): void => {
  const bounded = (value: unknown, maximum: number): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
  if (kind === "message" && !bounded(payload.text, 10_000)) {
    throw new ContextThreadError(
      "INVALID_CONTEXT_EVENT",
      "A message event needs text between 1 and 10000 characters.",
    );
  }
  if (kind === "status" && !bounded(payload.status, 100)) {
    throw new ContextThreadError("INVALID_CONTEXT_EVENT", "A status event needs a status.");
  }
  if (["tool", "artifact", "dispatch"].includes(kind) && !bounded(payload.title, 300)) {
    throw new ContextThreadError(
      "INVALID_CONTEXT_EVENT",
      `${kind} events need a short title.`,
    );
  }
  if (canonicalJson(payload).length > 50_000) {
    throw new ContextThreadError("INVALID_CONTEXT_EVENT", "Context event payload is too large.");
  }
};

/**
 * Append exactly one event and allocate its order on the Context row.
 * The increment and insert share a transaction: concurrent writers serialize
 * on the same row and either commit both the sequence and event, or neither.
 */
export const appendContextThreadEvent = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  actor: { kind: ActorKind; id?: string | null; displayName: string };
  kind: EventKind;
  payload: Record<string, unknown>;
}): Promise<ContextThreadEntry> => {
  if (!ACTORS.includes(params.actor.kind) || !EVENTS.includes(params.kind)) {
    throw new ContextThreadError("INVALID_CONTEXT_EVENT", "Unknown Context event kind.");
  }
  if (!params.actor.displayName.trim() || params.actor.displayName.length > 200) {
    throw new ContextThreadError("INVALID_CONTEXT_EVENT", "The event actor needs a display name.");
  }
  validatePayload(params.kind, params.payload);

  const row = await params.prisma.$transaction(async (tx: any) => {
    const incremented = await tx.agentContext.updateMany({
      where: { id: params.contextId, drawingId: params.drawingId },
      data: { nextEventSequence: { increment: 1 } },
    });
    if (incremented.count !== 1) {
      throw new ContextThreadError("CONTEXT_NOT_FOUND", "Agent Context does not exist.");
    }
    const context = await tx.agentContext.findUniqueOrThrow({
      where: { id: params.contextId },
      select: { nextEventSequence: true },
    });
    return tx.agentContextEvent.create({
      data: {
        contextId: params.contextId,
        sequence: context.nextEventSequence,
        actorKind: params.actor.kind,
        actorId: params.actor.id ?? null,
        actorDisplayName: params.actor.displayName.trim(),
        eventKind: params.kind,
        payload: canonicalJson(params.payload),
      },
    });
  });
  return toEntry(row);
};

export const listContextThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  afterSequence?: number;
  limit?: number;
}): Promise<ContextThreadEntry[]> => {
  const context = await params.prisma.agentContext.findFirst({
    where: { id: params.contextId, drawingId: params.drawingId },
    select: { id: true },
  });
  if (!context) {
    throw new ContextThreadError("CONTEXT_NOT_FOUND", "Agent Context does not exist.");
  }
  const rows = await params.prisma.agentContextEvent.findMany({
    where: {
      contextId: params.contextId,
      sequence: { gt: Math.max(0, params.afterSequence ?? 0) },
    },
    orderBy: { sequence: "asc" },
    take: Math.min(200, Math.max(1, params.limit ?? 100)),
  });
  return rows.map(toEntry);
};

export const contextThreadEventKinds = EVENTS;
