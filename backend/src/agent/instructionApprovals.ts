import { decodeSnapshotField } from "../snapshots/snapshotCodec";
import { contextIndex, materializeAgentBoardRevision } from "./boardMount";
import {
  INSTRUCTION_RELATION_KINDS,
  InstructionClosureError,
  type InstructionClosure,
  type InstructionSemanticRelation,
  compileInstructionClosure,
} from "./instructionClosure";

type Element = Record<string, unknown>;
type ContextSnapshot = {
  id: string;
  frameElementId: string;
  pinned: boolean;
  frameName: string | null;
};

export class InstructionApprovalError extends Error {
  constructor(
    public readonly code:
      | "CONTEXT_NOT_FOUND"
      | "INSTRUCTION_NOT_TEXT"
      | "SEMANTIC_RELATION_INVALID"
      | "APPROVAL_NOT_FOUND"
      | "APPROVAL_EXPIRED"
      | "APPROVAL_PREVIEW_STALE",
    message: string,
  ) {
    super(message);
    this.name = "InstructionApprovalError";
  }
}

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const liveElements = (value: unknown): Element[] =>
  Array.isArray(value)
    ? value.filter(
        (element): element is Element =>
          Boolean(element) &&
          typeof element === "object" &&
          !Array.isArray(element) &&
          typeof (element as Element).id === "string" &&
          (element as Element).isDeleted !== true,
      )
    : [];

const relationsForContext = (value: string, contextId: string): InstructionSemanticRelation[] => {
  const rows = parseJson<unknown[]>(value, []);
  const relations: InstructionSemanticRelation[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new InstructionApprovalError(
        "SEMANTIC_RELATION_INVALID",
        "The pinned semantic relation map is invalid.",
      );
    }
    const relation = row as Record<string, unknown>;
    if (relation.contextId !== contextId) continue;
    if (
      typeof relation.fromElementId !== "string" ||
      typeof relation.toElementId !== "string" ||
      !INSTRUCTION_RELATION_KINDS.includes(relation.kind as InstructionSemanticRelation["kind"])
    ) {
      throw new InstructionApprovalError(
        "SEMANTIC_RELATION_INVALID",
        "The pinned semantic relation map contains an unknown relation.",
      );
    }
    relations.push({
      fromElementId: relation.fromElementId,
      toElementId: relation.toElementId,
      kind: relation.kind as InstructionSemanticRelation["kind"],
    });
  }
  return relations;
};

/** Compile from an immutable revision, the only input allowed at dispatch. */
export const compileInstructionClosureFromRevision = (params: {
  revision: { elements: string; contextMap: string; semanticRelations: string };
  contextId: string;
  elementId: string;
}): InstructionClosure => {
  const elements = liveElements(
    parseJson<unknown[]>(decodeSnapshotField(params.revision.elements), []),
  );
  const contexts = parseJson<ContextSnapshot[]>(params.revision.contextMap, []);
  if (!contexts.some((context) => context.id === params.contextId)) {
    throw new InstructionApprovalError(
      "CONTEXT_NOT_FOUND",
      "Agent Context does not exist in revision.",
    );
  }
  const { byId, resolve } = contextIndex(elements, contexts);
  const instruction = byId.get(params.elementId);
  if (!instruction || instruction.type !== "text") {
    throw new InstructionApprovalError(
      "INSTRUCTION_NOT_TEXT",
      "Only an authored text element may become an Agent instruction.",
    );
  }
  try {
    return compileInstructionClosure({
      contextId: params.contextId,
      instructionElementId: params.elementId,
      elements,
      relations: relationsForContext(params.revision.semanticRelations ?? "[]", params.contextId),
      resolveContextId: resolve,
    });
  } catch (error) {
    if (error instanceof InstructionClosureError) {
      throw new InstructionApprovalError("SEMANTIC_RELATION_INVALID", error.message);
    }
    throw error;
  }
};

export const approveInstruction = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  elementId: string;
  approvedByUserId: string;
  /** Hash named by the server-generated preview the human just reviewed. */
  expectedClosureHash: string;
}) => {
  const revision = await materializeAgentBoardRevision(params.prisma, params.drawingId);
  const closure = compileInstructionClosureFromRevision({
    revision,
    contextId: params.contextId,
    elementId: params.elementId,
  });
  if (params.expectedClosureHash !== closure.closureHash) {
    throw new InstructionApprovalError(
      "APPROVAL_PREVIEW_STALE",
      "The instruction changed since its preview. Review the current version before approving.",
    );
  }
  const approval = await params.prisma.agentInstructionApproval.upsert({
    where: { contextId_elementId: { contextId: params.contextId, elementId: params.elementId } },
    create: {
      drawingId: params.drawingId,
      contextId: params.contextId,
      elementId: params.elementId,
      schemaVersion: closure.schemaVersion,
      semanticHash: closure.semanticHash,
      closureHash: closure.closureHash,
      approvedByUserId: params.approvedByUserId,
      authority: "instruction",
      approvedRevisionId: revision.id,
    },
    update: {
      schemaVersion: closure.schemaVersion,
      semanticHash: closure.semanticHash,
      closureHash: closure.closureHash,
      approvedByUserId: params.approvedByUserId,
      authority: "instruction",
      approvedRevisionId: revision.id,
      approvedAt: new Date(),
    },
  });
  return {
    approval: {
      id: approval.id,
      contextId: approval.contextId,
      elementId: approval.elementId,
      approvedByUserId: approval.approvedByUserId,
      approvedAt: approval.approvedAt.toISOString(),
    },
    closure,
    revisionId: revision.id,
  };
};

export const previewInstructionApproval = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  elementId: string;
}) => {
  const revision = await materializeAgentBoardRevision(params.prisma, params.drawingId);
  const closure = compileInstructionClosureFromRevision({
    revision,
    contextId: params.contextId,
    elementId: params.elementId,
  });
  return { revisionId: revision.id, closure };
};

/**
 * Human-authored semantic relations are data, not authority. They still use
 * the server's Context map so a relation cannot point outside the Context and
 * thereby smuggle new read scope into a later approval.
 */
export const upsertInstructionSemanticRelation = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  fromElementId: string;
  toElementId: string;
  kind: InstructionSemanticRelation["kind"];
  createdByUserId: string;
}) => {
  if (!INSTRUCTION_RELATION_KINDS.includes(params.kind)) {
    throw new InstructionApprovalError("SEMANTIC_RELATION_INVALID", "Unknown semantic relation.");
  }
  const revision = await materializeAgentBoardRevision(params.prisma, params.drawingId);
  const elements = liveElements(parseJson<unknown[]>(decodeSnapshotField(revision.elements), []));
  const contexts = parseJson<ContextSnapshot[]>(revision.contextMap, []);
  const { byId, resolve } = contextIndex(elements, contexts);
  const from = byId.get(params.fromElementId);
  const to = byId.get(params.toElementId);
  if (!from || !to || resolve(from) !== params.contextId || resolve(to) !== params.contextId) {
    throw new InstructionApprovalError(
      "SEMANTIC_RELATION_INVALID",
      "Semantic relation endpoints must be live elements in the named Agent Context.",
    );
  }
  return params.prisma.agentSemanticRelation.upsert({
    where: {
      contextId_fromElementId_toElementId_kind: {
        contextId: params.contextId,
        fromElementId: params.fromElementId,
        toElementId: params.toElementId,
        kind: params.kind,
      },
    },
    create: {
      drawingId: params.drawingId,
      contextId: params.contextId,
      fromElementId: params.fromElementId,
      toElementId: params.toElementId,
      kind: params.kind,
      createdByUserId: params.createdByUserId,
    },
    update: { createdByUserId: params.createdByUserId },
    select: { id: true, contextId: true, fromElementId: true, toElementId: true, kind: true },
  });
};

/**
 * A stale approval is not deleted: preserving it makes the inexpensive
 * re-approval affordance explainable (who approved what, and which current
 * hash differs) while the false state remains server-authoritative.
 */
export const readInstructionApprovalStatus = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  elementId: string;
  revision?: any;
  /** A caller that projects a batch may supply the one preloaded row. */
  approval?: any | null;
}) => {
  const approval =
    params.approval === undefined
      ? await params.prisma.agentInstructionApproval.findFirst({
          where: {
            drawingId: params.drawingId,
            contextId: params.contextId,
            elementId: params.elementId,
            authority: "instruction",
          },
        })
      : params.approval;
  if (!approval) return { status: "none" as const, approval: null };
  const revision =
    params.revision ?? (await materializeAgentBoardRevision(params.prisma, params.drawingId));
  try {
    const closure = compileInstructionClosureFromRevision({
      revision,
      contextId: params.contextId,
      elementId: params.elementId,
    });
    const valid =
      approval.schemaVersion === closure.schemaVersion &&
      approval.semanticHash === closure.semanticHash &&
      approval.closureHash === closure.closureHash;
    return {
      status: valid ? ("approved" as const) : ("expired" as const),
      approval: {
        id: approval.id,
        approvedByUserId: approval.approvedByUserId,
        approvedAt: approval.approvedAt.toISOString(),
      },
      revisionId: revision.id,
      closure,
    };
  } catch (error) {
    return {
      status: "expired" as const,
      approval: {
        id: approval.id,
        approvedByUserId: approval.approvedByUserId,
        approvedAt: approval.approvedAt.toISOString(),
      },
      revisionId: revision.id,
      errorCode: error instanceof Error ? error.name : "INSTRUCTION_CLOSURE_INVALID",
    };
  }
};

/** The only future dispatch seam: stale or absent approvals fail closed. */
export const requireCurrentInstructionApproval = async (params: {
  prisma: any;
  drawingId: string;
  contextId: string;
  elementId: string;
  revision: any;
  approval?: any | null;
}) => {
  const status = await readInstructionApprovalStatus(params);
  if (status.status === "none") {
    throw new InstructionApprovalError(
      "APPROVAL_NOT_FOUND",
      "A human must explicitly approve this instruction before dispatch.",
    );
  }
  if (status.status !== "approved") {
    throw new InstructionApprovalError(
      "APPROVAL_EXPIRED",
      "The instruction changed after its human approval and must be approved again.",
    );
  }
  return status;
};
