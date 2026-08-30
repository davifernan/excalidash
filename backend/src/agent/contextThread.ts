import { canonicalJson } from "./canonicalJson";
import { logger } from "../logger";

const ACTORS = ["user", "agent", "system"] as const;
/**
 * `edit` and `retract` are corrections, not content: they never carry their
 * own message/tool/status/artifact/dispatch meaning, only a reference to the
 * root event they correct. Kept in the same `EVENTS` union (both are still
 * ordinary appended rows, sharing the exact same append path and sequence
 * allocation) but partitioned out by `ROOT_EVENT_KINDS` wherever "what is
 * this thread actually about" is the question, versus "what happened to the
 * log" being the question.
 */
const ROOT_EVENTS = ["message", "tool", "status", "artifact", "dispatch"] as const;
const CORRECTION_EVENTS = ["edit", "retract"] as const;
const EVENTS = [...ROOT_EVENTS, ...CORRECTION_EVENTS] as const;

type ActorKind = (typeof ACTORS)[number];
type EventKind = (typeof EVENTS)[number];

export type AgentThreadEntry = {
  id: string;
  threadId: string;
  sequence: number;
  actor: { kind: ActorKind; id: string | null; displayName: string };
  kind: EventKind;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ContextThreadEntry = AgentThreadEntry & { contextId: string };

export class AgentThreadError extends Error {
  constructor(
    public readonly code: "THREAD_NOT_FOUND" | "INVALID_THREAD_EVENT",
    message: string,
  ) {
    super(message);
    this.name = "AgentThreadError";
  }
}

export class ContextThreadError extends Error {
  constructor(
    public readonly code: "CONTEXT_NOT_FOUND" | "INVALID_CONTEXT_EVENT",
    message: string,
  ) {
    super(message);
    this.name = "ContextThreadError";
  }
}

export class ContextThreadCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextThreadCorruptionError";
  }
}

type CorruptionMetadata = {
  eventKind?: EventKind;
  parserErrorType?: string;
  allowedValues?: readonly string[];
  allowedTypes?: readonly string[];
};

const corruptRow = (row: any, reason: string, metadata?: CorruptionMetadata): never => {
  logger.error("Stored Agent thread event is corrupt", {
    threadId: row?.threadId,
    eventId: row?.id,
    sequence: row?.sequence,
    createdAt: row?.createdAt instanceof Date ? row.createdAt.toISOString() : undefined,
    reason,
    ...metadata,
  });
  throw new ContextThreadCorruptionError(
    `Stored Agent thread event ${String(row?.id ?? "<unknown>")} is corrupt: ${reason}`,
  );
};

const parsePayload = (row: any): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(row.payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return corruptRow(row, "payload is not a JSON object", { eventKind: row.eventKind });
    }
    return parsed;
  } catch (error) {
    if (error instanceof ContextThreadCorruptionError) throw error;
    return corruptRow(row, "payload is not valid JSON", {
      // Parser messages and stacks can echo the malformed payload. The type
      // identifies this failure class without forwarding any stored content.
      eventKind: row.eventKind,
      parserErrorType: error instanceof Error ? error.name : typeof error,
    });
  }
};

const toEntry = (row: any): AgentThreadEntry => {
  if (!(ACTORS as readonly unknown[]).includes(row.actorKind)) {
    return corruptRow(row, "actor kind is outside the allowed set", {
      allowedValues: ACTORS,
    });
  }
  if (!(EVENTS as readonly unknown[]).includes(row.eventKind)) {
    return corruptRow(row, "event kind is outside the allowed set", {
      allowedValues: EVENTS,
    });
  }
  if (row.actorId !== null && typeof row.actorId !== "string") {
    return corruptRow(row, "actor id has an invalid stored type", {
      eventKind: row.eventKind,
      allowedTypes: ["string", "null"],
    });
  }
  return {
    id: row.id,
    threadId: row.threadId,
    sequence: row.sequence,
    actor: {
      kind: row.actorKind,
      id: row.actorId,
      displayName: row.actorDisplayName,
    },
    kind: row.eventKind,
    payload: parsePayload(row),
    createdAt: row.createdAt.toISOString(),
  };
};

const validatePayload = (kind: EventKind, payload: Record<string, unknown>): string => {
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
    throw new ContextThreadError("INVALID_CONTEXT_EVENT", `${kind} events need a short title.`);
  }
  if (kind === "edit" && (!bounded(payload.supersedes, 200) || !bounded(payload.text, 10_000))) {
    throw new ContextThreadError(
      "INVALID_CONTEXT_EVENT",
      "An edit event needs the superseded event's id and new text between 1 and 10000 characters.",
    );
  }
  if (kind === "retract" && !bounded(payload.retracts, 200)) {
    throw new ContextThreadError(
      "INVALID_CONTEXT_EVENT",
      "A retract event needs the retracted event's id.",
    );
  }
  const serializedPayload = canonicalJson(payload);
  if (serializedPayload.length > 50_000) {
    throw new ContextThreadError("INVALID_CONTEXT_EVENT", "Context event payload is too large.");
  }
  return serializedPayload;
};

/**
 * Append exactly one event and allocate its order on the AgentThread row.
 * The increment and insert share a transaction: concurrent writers serialize
 * on the same row and either commit both the sequence and event, or neither.
 */
export const appendAgentThreadEvent = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
  actor: { kind: ActorKind; id?: string | null; displayName: string };
  kind: EventKind;
  payload: Record<string, unknown>;
}): Promise<AgentThreadEntry> => {
  if (!ACTORS.includes(params.actor.kind) || !EVENTS.includes(params.kind)) {
    throw new AgentThreadError("INVALID_THREAD_EVENT", "Unknown Agent thread event kind.");
  }
  if (!params.actor.displayName.trim() || params.actor.displayName.length > 200) {
    throw new AgentThreadError("INVALID_THREAD_EVENT", "The event actor needs a display name.");
  }
  let serializedPayload: string;
  try {
    serializedPayload = validatePayload(params.kind, params.payload);
  } catch (error) {
    if (error instanceof ContextThreadError) {
      throw new AgentThreadError("INVALID_THREAD_EVENT", error.message);
    }
    throw error;
  }

  const row = await params.prisma.$transaction(async (tx: any) => {
    const incremented = await tx.agentThread.updateMany({
      where: { id: params.threadId, drawingId: params.drawingId },
      data: { nextEventSequence: { increment: 1 } },
    });
    if (incremented.count !== 1) {
      throw new AgentThreadError("THREAD_NOT_FOUND", "Agent thread does not exist.");
    }
    const thread = await tx.agentThread.findUniqueOrThrow({
      where: { id: params.threadId },
      select: { nextEventSequence: true },
    });
    if (params.kind === "edit" || params.kind === "retract") {
      const referencedId =
        params.kind === "edit" ? params.payload.supersedes : params.payload.retracts;
      const referenced = await tx.agentThreadEvent.findFirst({
        where: { id: referencedId as string, threadId: params.threadId },
        select: { eventKind: true },
      });
      if (!referenced || !(ROOT_EVENTS as readonly string[]).includes(referenced.eventKind)) {
        throw new AgentThreadError(
          "INVALID_THREAD_EVENT",
          `${params.kind} must reference a message/tool/status/artifact/dispatch event in the same thread, not another correction.`,
        );
      }
    }
    return tx.agentThreadEvent.create({
      data: {
        threadId: params.threadId,
        sequence: thread.nextEventSequence,
        actorKind: params.actor.kind,
        actorId: params.actor.id ?? null,
        actorDisplayName: params.actor.displayName.trim(),
        eventKind: params.kind,
        payload: serializedPayload,
      },
    });
  });
  return toEntry(row);
};

export const listAgentThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
  afterSequence?: number;
  limit?: number;
}): Promise<AgentThreadEntry[]> => {
  const thread = await params.prisma.agentThread.findFirst({
    where: { id: params.threadId, drawingId: params.drawingId },
    select: { id: true },
  });
  if (!thread) {
    throw new AgentThreadError("THREAD_NOT_FOUND", "Agent thread does not exist.");
  }
  const rows = await params.prisma.agentThreadEvent.findMany({
    where: {
      threadId: params.threadId,
      sequence: { gt: Math.max(0, params.afterSequence ?? 0) },
    },
    orderBy: { sequence: "asc" },
    take: Math.min(200, Math.max(1, params.limit ?? 100)),
  });
  return rows.map(toEntry);
};

const contextThread = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
}): Promise<string> => {
  const context = await params.prisma.agentContext.findFirst({
    where: { id: params.contextId, drawingId: params.drawingId },
    select: { thread: { select: { id: true } } },
  });
  if (!context?.thread) {
    throw new ContextThreadError("CONTEXT_NOT_FOUND", "Agent Context does not exist.");
  }
  return context.thread.id;
};

const asContextEntry = (contextId: string, entry: AgentThreadEntry): ContextThreadEntry => ({
  ...entry,
  contextId,
});

export const appendContextThreadEvent = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  actor: { kind: ActorKind; id?: string | null; displayName: string };
  kind: EventKind;
  payload: Record<string, unknown>;
}): Promise<ContextThreadEntry> => {
  const threadId = await contextThread(params);
  try {
    return asContextEntry(params.contextId, await appendAgentThreadEvent({ ...params, threadId }));
  } catch (error) {
    if (error instanceof AgentThreadError) {
      throw new ContextThreadError(
        error.code === "THREAD_NOT_FOUND" ? "CONTEXT_NOT_FOUND" : "INVALID_CONTEXT_EVENT",
        error.message,
      );
    }
    throw error;
  }
};

export const listContextThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  afterSequence?: number;
  limit?: number;
}): Promise<ContextThreadEntry[]> => {
  const threadId = await contextThread(params);
  return (
    await listAgentThreadEvents({
      prisma: params.prisma,
      drawingId: params.drawingId,
      threadId,
      afterSequence: params.afterSequence,
      limit: params.limit,
    })
  ).map((entry) => asContextEntry(params.contextId, entry));
};

/**
 * A root event's status after every correction that names it is resolved.
 * `retracted` is terminal and unconditional: once any `retract` event
 * references a root, later `edit` events referencing the same root can never
 * revive it, regardless of sequence order between them. A retraction that a
 * stray later edit could silently undo would be worse than no retraction at
 * all -- the one guarantee a reader of this state actually needs is that a
 * retracted root's original content never leaks back out.
 */
export type ResolvedThreadEntry<T extends AgentThreadEntry = AgentThreadEntry> = {
  /** The root event, always present, never mutated. */
  original: T;
  status: "active" | "edited" | "retracted";
  /** Present only when `status === "edited"`: the latest edit event. */
  currentEdit: T | null;
  /** Every edit event found for this root, in sequence order (for a history view). */
  edits: readonly T[];
};

export type ResolvedContextThreadEntry = ResolvedThreadEntry<ContextThreadEntry>;

/**
 * The one place that decides what a root event currently means, given every
 * correction appended after it. Both readers below -- the chat view and the
 * run-context compiler -- call this and only this, so they cannot disagree
 * about a chain of corrections: same input, same function, same answer.
 *
 * `events` must be the full, unpaginated history for one Context: an edit or
 * retract can reference a root far earlier than any reasonable page size, and
 * resolving against a partial window would silently under-correct.
 */
export const resolveThreadState = <T extends AgentThreadEntry>(
  events: readonly T[],
): ResolvedThreadEntry<T>[] => {
  const roots = events
    .filter((event) => (ROOT_EVENTS as readonly string[]).includes(event.kind))
    .sort((left, right) => left.sequence - right.sequence);

  const correctionsFor = (rootId: string) =>
    events
      .filter((event) => {
        if (event.kind === "edit") return event.payload.supersedes === rootId;
        if (event.kind === "retract") return event.payload.retracts === rootId;
        return false;
      })
      .sort((left, right) => left.sequence - right.sequence);

  return roots.map((original) => {
    const corrections = correctionsFor(original.id);
    const retracted = corrections.some((event) => event.kind === "retract");
    const edits = corrections.filter((event) => event.kind === "edit");
    if (retracted) {
      return { original, status: "retracted", currentEdit: null, edits };
    }
    const currentEdit = edits.length > 0 ? edits[edits.length - 1]! : null;
    return {
      original,
      status: currentEdit ? "edited" : "active",
      currentEdit,
      edits,
    };
  });
};

/**
 * The chat view's reader: every root event, resolved, including retracted
 * ones (the UI shows a tombstone rather than making a message vanish without
 * a trace -- the same choice this repo already makes for a deleted Comment).
 * Fetches the Context's complete history; resolution needs the whole thing,
 * not a page of it (see `resolveThreadState`).
 */
const PAGE_LIMIT = 200;

const listAllAgentThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
}): Promise<AgentThreadEntry[]> => {
  const all: AgentThreadEntry[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await listAgentThreadEvents({ ...params, afterSequence, limit: PAGE_LIMIT });
    all.push(...page);
    if (page.length < PAGE_LIMIT) return all;
    afterSequence = page[page.length - 1]!.sequence;
  }
};

export const listResolvedAgentThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
}): Promise<ResolvedThreadEntry[]> => resolveThreadState(await listAllAgentThreadEvents(params));

export const resolveAgentThreadForRun = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
}): Promise<AgentThreadEntry[]> => {
  const resolved = await listResolvedAgentThreadEvents(params);
  return resolved
    .filter((entry) => entry.status !== "retracted")
    .map((entry) => entry.currentEdit ?? entry.original);
};

/**
 * Pages through `listContextThreadEvents` until exhausted. `limit` there is
 * capped at 200 per call for an ordinary chat-window read; resolution needs
 * every event regardless of how many there are, so this cannot settle for a
 * single capped call the way a naive "fetch some events" caller would.
 */
const listAllContextThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
}): Promise<ContextThreadEntry[]> => {
  const all: ContextThreadEntry[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await listContextThreadEvents({ ...params, afterSequence, limit: PAGE_LIMIT });
    all.push(...page);
    if (page.length < PAGE_LIMIT) return all;
    afterSequence = page[page.length - 1]!.sequence;
  }
};

export const listResolvedContextThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
}): Promise<ResolvedContextThreadEntry[]> => {
  const events = await listAllContextThreadEvents(params);
  return resolveThreadState(events);
};

/**
 * The run-context compiler's reader: only what the next agent run should
 * actually see. A retracted root is excluded entirely -- never present, not
 * even redacted -- and an edited root is represented by its current content,
 * never its original. This is the reader NIL-677/695's guest-contribution
 * exclusion and NIL-676's instruction approval will eventually sit beside;
 * this package only builds the correction-resolution half of it.
 */
export const resolveContextThreadForRun = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
}): Promise<ContextThreadEntry[]> => {
  const resolved = await listResolvedContextThreadEvents(params);
  return resolved
    .filter((entry) => entry.status !== "retracted")
    .map((entry) => entry.currentEdit ?? entry.original);
};

export const contextThreadEventKinds = EVENTS;
export const contextThreadRootEventKinds = ROOT_EVENTS;
export const contextThreadCorrectionEventKinds = CORRECTION_EVENTS;
