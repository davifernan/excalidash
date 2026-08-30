import type { BoardAgentRunAudience } from "./presence";
import {
  AgentThreadError,
  appendAgentThreadEvent,
  listAgentThreadEvents,
  type AgentThreadEntry,
} from "./contextThread";

const ORCHESTRATOR_KIND = "orchestrator";
const PRIVATE_AUDIENCE = "private";
const DRAWING_AUDIENCE = "drawing";

export type OrchestratorThread = {
  id: string;
  drawingId: string;
  audience: BoardAgentRunAudience;
  title: string;
  anchor: { kind: "private"; x: number; y: number } | { kind: "drawing"; elementId: string };
  createdAt: string;
  updatedAt: string;
};

export class OrchestratorThreadError extends Error {
  constructor(
    public readonly code:
      "THREAD_NOT_FOUND" | "THREAD_FORBIDDEN" | "THREAD_INVALID" | "SHARED_ANCHOR_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorThreadError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStoredSharedAnchor = (
  serializedElements: string,
  elementId: string,
): { title: string } | null => {
  let elements: unknown;
  try {
    elements = JSON.parse(serializedElements);
  } catch {
    return null;
  }
  if (!Array.isArray(elements)) return null;
  const element = elements.find(
    (candidate) =>
      isRecord(candidate) && candidate.id === elementId && candidate.isDeleted !== true,
  );
  if (!isRecord(element) || !isRecord(element.customData)) return null;
  const own = element.customData.excalidash;
  if (!isRecord(own) || own.schemaVersion !== 2 || !isRecord(own.orchestratorThread)) return null;
  const title = own.orchestratorThread.title;
  if (typeof title !== "string" || !title.trim() || title.length > 200) return null;
  return { title: title.trim() };
};

const toThread = (row: any): OrchestratorThread => {
  if (row.threadKind !== ORCHESTRATOR_KIND) {
    throw new OrchestratorThreadError(
      "THREAD_INVALID",
      "Stored row is not an orchestrator thread.",
    );
  }
  if (
    row.audienceKind === PRIVATE_AUDIENCE &&
    typeof row.audienceUserId === "string" &&
    typeof row.anchorX === "number" &&
    typeof row.anchorY === "number"
  ) {
    return {
      id: row.id,
      drawingId: row.drawingId,
      audience: { kind: "private", userId: row.audienceUserId },
      title: row.title,
      anchor: { kind: "private", x: row.anchorX, y: row.anchorY },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  if (row.audienceKind === DRAWING_AUDIENCE && typeof row.anchorElementId === "string") {
    return {
      id: row.id,
      drawingId: row.drawingId,
      audience: { kind: "drawing" },
      title: row.title,
      anchor: { kind: "drawing", elementId: row.anchorElementId },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  throw new OrchestratorThreadError(
    "THREAD_INVALID",
    "Stored orchestrator thread has an invalid immutable audience or anchor.",
  );
};

const finiteCoordinate = (value: number): boolean =>
  Number.isFinite(value) && Math.abs(value) <= 10_000_000;

/** One device-independent private thread per account and board. */
export const getOrCreatePrivateOrchestratorThread = async (params: {
  prisma: any;
  drawingId: string;
  userId: string;
  initialAnchor: { x: number; y: number };
}): Promise<OrchestratorThread> => {
  if (!finiteCoordinate(params.initialAnchor.x) || !finiteCoordinate(params.initialAnchor.y)) {
    throw new OrchestratorThreadError("THREAD_INVALID", "Private anchor coordinates are invalid.");
  }
  const row = await params.prisma.agentThread.upsert({
    where: {
      drawingId_threadKind_audienceUserId: {
        drawingId: params.drawingId,
        threadKind: ORCHESTRATOR_KIND,
        audienceUserId: params.userId,
      },
    },
    create: {
      drawingId: params.drawingId,
      threadKind: ORCHESTRATOR_KIND,
      audienceKind: PRIVATE_AUDIENCE,
      audienceUserId: params.userId,
      title: "Local orchestrator thread",
      anchorX: params.initialAnchor.x,
      anchorY: params.initialAnchor.y,
    },
    // Audience, owner, history and the user's prior anchor are immutable under
    // get-or-create. A second device must attach to the same thread, not reset it.
    update: {},
  });
  return toThread(row);
};

/** Register a shared thread only after its actual Board Card is persisted. */
export const registerDrawingOrchestratorThread = async (params: {
  prisma: any;
  drawingId: string;
  anchorElementId: string;
}): Promise<OrchestratorThread> =>
  params.prisma.$transaction(async (tx: any) => {
    // Registration and the ordinary scene-write paths serialize on the same
    // Drawing row. Otherwise a Board Card could disappear after validation
    // but before its drawing-audience thread is made durable.
    const affected = await tx.$executeRaw`
      UPDATE "Drawing"
      SET "id" = "id"
      WHERE "id" = ${params.drawingId}
    `;
    if (affected !== 1) {
      throw new OrchestratorThreadError(
        "SHARED_ANCHOR_NOT_FOUND",
        "The shared thread Board Card is not persisted on this drawing.",
      );
    }
    const drawing = await tx.drawing.findUnique({
      where: { id: params.drawingId },
      select: { elements: true },
    });
    const anchor = drawing
      ? readStoredSharedAnchor(drawing.elements, params.anchorElementId)
      : null;
    if (!anchor) {
      throw new OrchestratorThreadError(
        "SHARED_ANCHOR_NOT_FOUND",
        "The shared thread Board Card is not persisted on this drawing.",
      );
    }
    const row = await tx.agentThread.upsert({
      where: {
        drawingId_anchorElementId: {
          drawingId: params.drawingId,
          anchorElementId: params.anchorElementId,
        },
      },
      create: {
        drawingId: params.drawingId,
        threadKind: ORCHESTRATOR_KIND,
        audienceKind: DRAWING_AUDIENCE,
        anchorElementId: params.anchorElementId,
        title: anchor.title,
      },
      // A Board Card rename is presentation. It cannot replace its immutable
      // audience, identity or event history through this registration seam.
      update: { title: anchor.title },
    });
    return toThread(row);
  });

export const listVisibleOrchestratorThreads = async (params: {
  prisma: any;
  drawingId: string;
  userId: string | null;
}): Promise<OrchestratorThread[]> => {
  const rows = await params.prisma.agentThread.findMany({
    where: {
      drawingId: params.drawingId,
      threadKind: ORCHESTRATOR_KIND,
      OR: [
        { audienceKind: DRAWING_AUDIENCE, audienceUserId: null },
        ...(params.userId
          ? [{ audienceKind: PRIVATE_AUDIENCE, audienceUserId: params.userId }]
          : []),
      ],
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  return rows.map(toThread);
};

export const getVisibleOrchestratorThread = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
  userId: string | null;
}): Promise<OrchestratorThread> => {
  const row = await params.prisma.agentThread.findFirst({
    where: {
      id: params.threadId,
      drawingId: params.drawingId,
      threadKind: ORCHESTRATOR_KIND,
      OR: [
        { audienceKind: DRAWING_AUDIENCE, audienceUserId: null },
        ...(params.userId
          ? [{ audienceKind: PRIVATE_AUDIENCE, audienceUserId: params.userId }]
          : []),
      ],
    },
  });
  if (!row) {
    throw new OrchestratorThreadError("THREAD_NOT_FOUND", "Orchestrator thread does not exist.");
  }
  return toThread(row);
};

export const movePrivateOrchestratorThread = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
  userId: string;
  anchor: { x: number; y: number };
}): Promise<OrchestratorThread> => {
  if (!finiteCoordinate(params.anchor.x) || !finiteCoordinate(params.anchor.y)) {
    throw new OrchestratorThreadError("THREAD_INVALID", "Private anchor coordinates are invalid.");
  }
  const updated = await params.prisma.agentThread.updateMany({
    where: {
      id: params.threadId,
      drawingId: params.drawingId,
      threadKind: ORCHESTRATOR_KIND,
      audienceKind: PRIVATE_AUDIENCE,
      audienceUserId: params.userId,
    },
    data: { anchorX: params.anchor.x, anchorY: params.anchor.y },
  });
  if (updated.count !== 1) {
    throw new OrchestratorThreadError("THREAD_NOT_FOUND", "Private thread does not exist.");
  }
  const row = await params.prisma.agentThread.findUniqueOrThrow({ where: { id: params.threadId } });
  return toThread(row);
};

export const listOrchestratorThreadEvents = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
  userId: string | null;
  afterSequence?: number;
  limit?: number;
}): Promise<AgentThreadEntry[]> => {
  await getVisibleOrchestratorThread(params);
  return listAgentThreadEvents(params);
};

export const appendOrchestratorThreadMessage = async (params: {
  prisma: any;
  drawingId: string;
  threadId: string;
  userId: string;
  displayName: string;
  text: string;
}): Promise<{ thread: OrchestratorThread; event: AgentThreadEntry }> => {
  const thread = await getVisibleOrchestratorThread(params);
  try {
    const event = await appendAgentThreadEvent({
      prisma: params.prisma,
      drawingId: params.drawingId,
      threadId: params.threadId,
      actor: { kind: "user", id: params.userId, displayName: params.displayName },
      kind: "message",
      payload: { text: params.text },
    });
    return { thread, event };
  } catch (error) {
    if (error instanceof AgentThreadError) {
      throw new OrchestratorThreadError(
        error.code === "THREAD_NOT_FOUND" ? "THREAD_NOT_FOUND" : "THREAD_INVALID",
        error.message,
      );
    }
    throw error;
  }
};
