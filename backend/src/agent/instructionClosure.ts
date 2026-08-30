import { canonicalJson, sha256Json } from "./canonicalJson";

/**
 * The hash schema is deliberately versioned.  It is an authorization
 * fingerprint, not a best-effort cache key: changing this projection must
 * invalidate old approvals rather than silently reinterpret them.
 */
export const INSTRUCTION_CLOSURE_SCHEMA_VERSION = 1;

export const INSTRUCTION_RELATION_KINDS = [
  "depends_on",
  "references",
  "whole_frame",
  "group",
] as const;

export type InstructionRelationKind = (typeof INSTRUCTION_RELATION_KINDS)[number];

export type InstructionSemanticRelation = {
  fromElementId: string;
  toElementId: string;
  kind: InstructionRelationKind;
};

export type InstructionClosureInput = {
  contextId: string;
  instructionElementId: string;
  elements: readonly Record<string, unknown>[];
  /** Reused by a batch projection of one immutable revision. */
  elementsById?: ReadonlyMap<string, Record<string, unknown>>;
  /**
   * Context membership comes from the server-authoritative Context map, never
   * from bounds or a client supplied frame guess.
   */
  resolveContextId: (element: Record<string, unknown>) => string | null;
  /** Only explicitly authored, typed relations may enter the closure. */
  relations: readonly InstructionSemanticRelation[];
};

export type InstructionClosure = {
  schemaVersion: typeof INSTRUCTION_CLOSURE_SCHEMA_VERSION;
  contextId: string;
  semanticHash: string;
  closureHash: string;
  canonical: string;
};

export class InstructionClosureError extends Error {
  constructor(
    public readonly code:
      | "INSTRUCTION_MISSING"
      | "INSTRUCTION_OUTSIDE_CONTEXT"
      | "INVALID_RELATION"
      | "RELATION_TARGET_MISSING"
      | "FOREIGN_CONTEXT_REFERENCE",
    message: string,
  ) {
    super(message);
    this.name = "InstructionClosureError";
  }
}

type Element = Record<string, unknown>;

const normalizedText = (value: string): string => value.replace(/\r\n?/g, "\n").normalize("NFC");

const string = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const liveElementsById = (elements: readonly Element[]): Map<string, Element> =>
  new Map(
    elements
      .filter((element) => element.isDeleted !== true)
      .flatMap((element) => {
        const id = string(element.id);
        return id ? [[id, element] as const] : [];
      }),
  );

/**
 * This is intentionally smaller than an Excalidraw element.  Geometry,
 * colours, font size, z-index and raw element versions are presentation or
 * mutation hints, never machine meaning.  `originalText` is the authored
 * string; regular live Excalidraw text elements always carry it. Excalidraw's
 * wrapped `text` must not make a reflow look meaningful; its fallback exists
 * only for historical incomplete records.
 */
const semanticProjection = (element: Element) => {
  const type = string(element.type) ?? "unknown";
  const originalText = string(element.originalText);
  const renderedText = string(element.text);
  return {
    id: string(element.id) ?? "",
    type,
    ...(originalText !== null
      ? { text: normalizedText(originalText) }
      : renderedText !== null
        ? { text: normalizedText(renderedText) }
        : {}),
    ...(string(element.link) !== null ? { link: string(element.link) } : {}),
  };
};

const relationOrder = (left: InstructionSemanticRelation, right: InstructionSemanticRelation) =>
  `${left.kind}\u0000${left.fromElementId}\u0000${left.toElementId}`.localeCompare(
    `${right.kind}\u0000${right.fromElementId}\u0000${right.toElementId}`,
  );

const assertRelation = (
  relation: InstructionSemanticRelation,
  byId: ReadonlyMap<string, Element>,
  contextId: string,
  resolveContextId: InstructionClosureInput["resolveContextId"],
) => {
  if (
    !INSTRUCTION_RELATION_KINDS.includes(relation.kind) ||
    !relation.fromElementId ||
    !relation.toElementId
  ) {
    throw new InstructionClosureError("INVALID_RELATION", "Instruction relation is invalid.");
  }
  const from = byId.get(relation.fromElementId);
  const to = byId.get(relation.toElementId);
  if (!from || !to) {
    throw new InstructionClosureError(
      "RELATION_TARGET_MISSING",
      "A typed instruction relation no longer has both endpoints.",
    );
  }
  if (resolveContextId(from) !== contextId || resolveContextId(to) !== contextId) {
    throw new InstructionClosureError(
      "FOREIGN_CONTEXT_REFERENCE",
      "Instruction relations may not expand the approved Context boundary.",
    );
  }
};

/**
 * Compile one instruction's explicit semantic closure.  The return contains
 * only stable data and is safe to persist in an approval record.  A caller
 * recomputes it from a pinned revision at dispatch; it must never trust the
 * client's prior hash.
 */
export const compileInstructionClosure = (input: InstructionClosureInput): InstructionClosure => {
  const byId = input.elementsById ?? liveElementsById(input.elements);
  const instruction = byId.get(input.instructionElementId);
  if (!instruction) {
    throw new InstructionClosureError("INSTRUCTION_MISSING", "Instruction element does not exist.");
  }
  if (input.resolveContextId(instruction) !== input.contextId) {
    throw new InstructionClosureError(
      "INSTRUCTION_OUTSIDE_CONTEXT",
      "Instruction element is not in the named Agent Context.",
    );
  }

  const relations = [...input.relations].sort(relationOrder);

  const outgoing = new Map<string, InstructionSemanticRelation[]>();
  for (const relation of relations) {
    const current = outgoing.get(relation.fromElementId) ?? [];
    current.push(relation);
    outgoing.set(relation.fromElementId, current);
  }

  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const relation of outgoing.get(id) ?? []) visit(relation.toElementId);
  };
  visit(input.instructionElementId);

  // A Context may retain stale declarations for unrelated, deleted work.
  // They must not block approval of this instruction; validate only relations
  // that its closure actually traverses.
  const reachableRelations = () =>
    relations.filter((relation) => reachable.has(relation.fromElementId));

  const validatedRelations = new Set<InstructionSemanticRelation>();
  const validateReachableRelation = (relation: InstructionSemanticRelation) => {
    if (validatedRelations.has(relation)) return;
    try {
      assertRelation(relation, byId, input.contextId, input.resolveContextId);
      validatedRelations.add(relation);
    } catch (error) {
      if (error instanceof InstructionClosureError) {
        throw new InstructionClosureError(
          error.code,
          `Relation ${relation.fromElementId} -> ${relation.toElementId} (${relation.kind}) is invalid: ${error.message}`,
        );
      }
      throw error;
    }
  };

  // A whole-frame relation means the authored instruction explicitly says
  // that the frame's complete current content is meaningful. Its members can
  // themselves introduce another whole-frame relation, so work from a growing
  // queue rather than a one-time reachableRelations() snapshot.
  const wholeFrameWorklist: InstructionSemanticRelation[] = [];
  const scheduledWholeFrameRelations = new Set<InstructionSemanticRelation>();
  const enqueueReachableWholeFrameRelations = () => {
    for (const relation of reachableRelations()) {
      if (relation.kind !== "whole_frame" || scheduledWholeFrameRelations.has(relation)) continue;
      scheduledWholeFrameRelations.add(relation);
      wholeFrameWorklist.push(relation);
    }
  };
  enqueueReachableWholeFrameRelations();

  for (const relation of wholeFrameWorklist) {
    validateReachableRelation(relation);
    const frame = byId.get(relation.toElementId)!;
    if (frame.type !== "frame") {
      throw new InstructionClosureError(
        "INVALID_RELATION",
        "A whole_frame relation must target a frame element.",
      );
    }
    for (const [id, candidate] of byId) {
      if (
        candidate.frameId === relation.toElementId &&
        input.resolveContextId(candidate) === input.contextId
      ) {
        visit(id);
      }
    }
    enqueueReachableWholeFrameRelations();
  }

  reachableRelations().forEach(validateReachableRelation);

  const nodes = [...reachable]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => semanticProjection(byId.get(id)!));
  const edges = reachableRelations()
    .filter(
      (relation) => reachable.has(relation.fromElementId) && reachable.has(relation.toElementId),
    )
    .map((relation) => ({
      fromElementId: relation.fromElementId,
      kind: relation.kind,
      toElementId: relation.toElementId,
    }));
  const root = semanticProjection(instruction);
  const semanticHash = sha256Json({ schemaVersion: INSTRUCTION_CLOSURE_SCHEMA_VERSION, root });
  const closure = {
    schemaVersion: INSTRUCTION_CLOSURE_SCHEMA_VERSION,
    contextId: input.contextId,
    instruction: root,
    dependencies: { edges, nodes },
  };
  return {
    schemaVersion: INSTRUCTION_CLOSURE_SCHEMA_VERSION,
    contextId: input.contextId,
    semanticHash,
    closureHash: sha256Json(closure),
    canonical: canonicalJson(closure),
  };
};
