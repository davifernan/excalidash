import { resolveAgentContextContributePolicy } from "../authz/capabilities";
import {
  elementIdsInContextFrame,
  markUnknownElementProvenanceGuestTouched,
  readElementGuestProvenance,
} from "./elementGuestProvenance";

export type ContextIdentity = {
  id: string;
  frameElementId: string;
  pinned: boolean;
};

export type ContextRegistration = ContextIdentity & {
  provenanceReview: {
    confirmationRequired: boolean;
    elementIdsRequiringConfirmation: string[];
  };
};

type Element = Record<string, unknown>;
type Bounds = { x: number; y: number; width: number; height: number };

/** A raw scene entry as a plain, non-array object -- the shape every element record filter here needs. */
const asElementRecords = (elements: readonly unknown[]): Element[] =>
  elements.filter(
    (element): element is Element =>
      typeof element === "object" && element !== null && !Array.isArray(element),
  );

export class AgentContextValidationError extends Error {
  constructor(
    public readonly code:
      "CONTEXT_FRAME_MISSING" | "CONTEXT_FRAME_INVALID" | "CONTEXT_FRAMES_OVERLAP",
    message: string,
  ) {
    super(message);
    this.name = "AgentContextValidationError";
  }
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const frameBounds = (element: Element): Bounds | null => {
  const x = finite(element.x);
  const y = finite(element.y);
  const width = finite(element.width);
  const height = finite(element.height);
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width === 0 ||
    height === 0
  ) {
    return null;
  }
  // Rotation is conservatively represented by its enclosing AABB. This can
  // reject a visually close pair, but it can never bless an ambiguous overlap.
  const angle = finite(element.angle) ?? 0;
  const absWidth = Math.abs(width);
  const absHeight = Math.abs(height);
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const aabbWidth = Math.abs(absWidth * Math.cos(angle)) + Math.abs(absHeight * Math.sin(angle));
  const aabbHeight = Math.abs(absWidth * Math.sin(angle)) + Math.abs(absHeight * Math.cos(angle));
  return {
    x: centerX - aabbWidth / 2,
    y: centerY - aabbHeight / 2,
    width: aabbWidth,
    height: aabbHeight,
  };
};

const overlaps = (left: Bounds, right: Bounds): boolean =>
  left.x < right.x + right.width &&
  left.x + left.width > right.x &&
  left.y < right.y + right.height &&
  left.y + left.height > right.y;

/** Validate the persisted context-to-frame truth against one scene image. */
export const validateContextFrames = (
  elements: readonly Element[],
  contexts: readonly ContextIdentity[],
): Map<string, Element> => {
  const liveById = new Map(
    elements
      .filter((element) => element.isDeleted !== true && typeof element.id === "string")
      .map((element) => [element.id as string, element]),
  );
  const frames = new Map<string, Element>();
  const seenFrameIds = new Set<string>();
  for (const context of contexts) {
    if (seenFrameIds.has(context.frameElementId)) {
      throw new AgentContextValidationError(
        "CONTEXT_FRAME_INVALID",
        `Frame ${context.frameElementId} identifies more than one Context.`,
      );
    }
    seenFrameIds.add(context.frameElementId);
    const frame = liveById.get(context.frameElementId);
    if (!frame) {
      throw new AgentContextValidationError(
        "CONTEXT_FRAME_MISSING",
        `Context ${context.id} names a frame that is not in the board.`,
      );
    }
    if (frame.type !== "frame" || !frameBounds(frame)) {
      throw new AgentContextValidationError(
        "CONTEXT_FRAME_INVALID",
        `Context ${context.id} must identify a live, bounded frame.`,
      );
    }
    frames.set(context.id, frame);
  }

  for (let left = 0; left < contexts.length; left += 1) {
    for (let right = left + 1; right < contexts.length; right += 1) {
      const leftContext = contexts[left]!;
      const rightContext = contexts[right]!;
      const leftBounds = frameBounds(frames.get(leftContext.id)!)!;
      const rightBounds = frameBounds(frames.get(rightContext.id)!)!;
      if (overlaps(leftBounds, rightBounds)) {
        throw new AgentContextValidationError(
          "CONTEXT_FRAMES_OVERLAP",
          `Contexts ${leftContext.id} and ${rightContext.id} have overlapping frames.`,
        );
      }
    }
  }
  return frames;
};

/**
 * Serialize Context registration and scene replacement on the Drawing row.
 * The no-op update acquires SQLite's write lock and PostgreSQL's row lock
 * without changing the board's version, timestamp, or content. Callers must
 * pass the transaction client that will perform the related read/write.
 */
const lockContextDrawing = async (prisma: any, drawingId: string): Promise<void> => {
  const affected = await prisma.$executeRaw`
    UPDATE "Drawing"
    SET "id" = "id"
    WHERE "id" = ${drawingId}
  `;
  if (affected !== 1) {
    throw new AgentContextValidationError("CONTEXT_FRAME_MISSING", "Drawing does not exist.");
  }
};

/**
 * The sole context-registration write seam for later UI work (NIL-675).
 * Authorization deliberately remains at the calling route; this function
 * owns identity and geometric invariants, not who may edit a drawing.
 */
export const registerAgentContext = async (params: {
  prisma: any;
  drawingId: string;
  frameElementId: string;
  pinned?: boolean;
}): Promise<ContextRegistration> =>
  params.prisma.$transaction(async (tx: any) => {
    await lockContextDrawing(tx, params.drawingId);
    const drawing = await tx.drawing.findUnique({
      where: { id: params.drawingId },
      select: { elements: true },
    });
    if (!drawing) {
      throw new AgentContextValidationError("CONTEXT_FRAME_MISSING", "Drawing does not exist.");
    }
    const elements = JSON.parse(drawing.elements) as Element[];
    const existing = await tx.agentContext.findMany({
      where: { drawingId: params.drawingId },
      select: { id: true, frameElementId: true, pinned: true },
    });
    const candidate = {
      id: `candidate:${params.frameElementId}`,
      frameElementId: params.frameElementId,
      pinned: params.pinned ?? false,
    };
    validateContextFrames(elements, [...existing, candidate]);
    const created = await tx.agentContext.create({
      data: {
        drawingId: params.drawingId,
        frameElementId: params.frameElementId,
        pinned: params.pinned ?? false,
      },
      select: { id: true, frameElementId: true, pinned: true },
    });
    const contextElementIds = elementIdsInContextFrame(elements, params.frameElementId);
    const provenance = await readElementGuestProvenance(tx, params.drawingId, contextElementIds);
    const unknownElementIds = provenance
      .filter((entry) => entry.status === "unknown")
      .map((entry) => entry.elementId);
    const elementIdsRequiringConfirmation = provenance
      .filter((entry) => entry.status !== "confirmed-clean")
      .map((entry) => entry.elementId);
    // Context registration is the explicit boundary at which legacy absence
    // stops being ephemeral. Unknown content is persisted fail-closed as
    // guest-touched; only the audited human confirmation seam may clear it.
    await markUnknownElementProvenanceGuestTouched({
      prisma: tx,
      drawingId: params.drawingId,
      elementIds: unknownElementIds,
    });
    return {
      ...created,
      provenanceReview: {
        confirmationRequired: elementIdsRequiringConfirmation.length > 0,
        elementIdsRequiringConfirmation,
      },
    };
  });

/** Reject a scene mutation that would invalidate already registered Contexts. */
export const assertPersistedAgentContextFrames = async (
  prisma: any,
  drawingId: string,
  elements: readonly unknown[],
): Promise<void> => {
  await lockContextDrawing(prisma, drawingId);
  const contexts = (await prisma.agentContext.findMany({
    where: { drawingId },
    select: { id: true, frameElementId: true, pinned: true },
  })) as ContextIdentity[];
  if (contexts.length > 0) validateContextFrames(asElementRecords(elements), contexts);
};

export class AgentContextGuestWriteDeniedError extends Error {
  constructor(public readonly elementIds: readonly string[]) {
    super(
      `Guests cannot write to elements inside a registered Agent Context frame: ${elementIds.join(", ")}`,
    );
    this.name = "AgentContextGuestWriteDeniedError";
  }
}

/**
 * NIL-677 `agent_context:write`, Gate 1 (preventive). A guest may never
 * change an element that resolves -- directly or through its frame's own
 * frameId ancestry -- into a registered Agent Context frame, UNLESS the
 * board's `agentContextContribute` policy is on. NIL-677's own "Fertig,
 * wenn" criterion requires that one setting to govern both enforcement
 * layers, not just `agent_context:contribute` (Gate 2) -- so this reads the
 * exact same `resolveAgentContextContributePolicy` Gate 2 does, rather than
 * carrying its own copy of "is this on" that could drift from Gate 2's.
 * When the policy is off (the default), this stays the hard, unconditional
 * deny it always was. Checked against the RESULTING scene (the `elements`
 * argument), not the prior one, because the exact attack this exists to
 * stop is a guest dragging an element INTO the frame -- the frameId that
 * matters is the one the write is trying to produce.
 *
 * This is prevention, not the guarantee: a socket race, an old client, or an
 * overlooked sixth mutation path can still slip an element into a frame's
 * geometry without this check ever running. `executeAgentBoardTool`'s
 * context-eligibility filter (boardMount.ts) is Gate 2, the one that
 * actually decides what an agent reads, and never trusts this gate's
 * earlier judgment.
 */
export const assertGuestElementWriteAllowed = async (params: {
  prisma: any;
  drawingId: string;
  isGuest: boolean;
  changedElementIds: readonly string[];
  elements: readonly unknown[];
}): Promise<void> => {
  if (!params.isGuest || params.changedElementIds.length === 0) return;
  const contexts = (await params.prisma.agentContext.findMany({
    where: { drawingId: params.drawingId },
    select: { frameElementId: true },
  })) as { frameElementId: string }[];
  if (contexts.length === 0) return;
  if (await resolveAgentContextContributePolicy(params.prisma, params.drawingId)) return;
  const records = asElementRecords(params.elements);
  const protectedElementIds = new Set<string>();
  for (const context of contexts) {
    for (const id of elementIdsInContextFrame(records, context.frameElementId)) {
      protectedElementIds.add(id);
    }
  }
  const denied = params.changedElementIds.filter((id) => protectedElementIds.has(id));
  if (denied.length > 0) {
    throw new AgentContextGuestWriteDeniedError(denied);
  }
};

export const contextFrameBounds = (element: Element): Bounds | null => frameBounds(element);
