export type ContextIdentity = {
  id: string;
  frameElementId: string;
  pinned: boolean;
};

type Element = Record<string, unknown>;
type Bounds = { x: number; y: number; width: number; height: number };

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
}): Promise<ContextIdentity> =>
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
    return tx.agentContext.create({
      data: {
        drawingId: params.drawingId,
        frameElementId: params.frameElementId,
        pinned: params.pinned ?? false,
      },
      select: { id: true, frameElementId: true, pinned: true },
    });
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
  const records = elements.filter(
    (element): element is Element =>
      typeof element === "object" && element !== null && !Array.isArray(element),
  );
  if (contexts.length > 0) validateContextFrames(records, contexts);
};

export const contextFrameBounds = (element: Element): Bounds | null => frameBounds(element);
