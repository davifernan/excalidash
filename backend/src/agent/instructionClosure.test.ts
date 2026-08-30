import { describe, expect, it } from "vitest";
import {
  InstructionClosureError,
  compileInstructionClosure,
  type InstructionSemanticRelation,
} from "./instructionClosure";
import {
  compileInstructionClosureFromRevision,
  readInstructionApprovalStatus,
  requireCurrentInstructionApproval,
} from "./instructionApprovals";

type Element = Record<string, unknown>;

const scene = (overrides: Partial<Record<string, Partial<Element>>> = {}) => {
  const base: Record<string, Element> = {
    frame: { id: "frame", type: "frame", x: 0, y: 0, width: 400, height: 300 },
    instruction: {
      id: "instruction",
      type: "text",
      frameId: "frame",
      originalText: "Deploy the plan",
      text: "Deploy the plan",
      x: 10,
      y: 10,
      width: 100,
      height: 20,
      strokeColor: "#000000",
    },
    plan: {
      id: "plan",
      type: "text",
      frameId: "frame",
      originalText: "Run tests first",
      text: "Run tests first",
      x: 30,
      y: 30,
      width: 100,
      height: 20,
    },
    unrelated: {
      id: "unrelated",
      type: "text",
      frameId: "frame",
      originalText: "Decorative note",
      text: "Decorative note",
      x: 300,
      y: 200,
      width: 100,
      height: 20,
    },
  };
  return Object.values(base).map((element) => ({
    ...element,
    ...(overrides[String(element.id)] ?? {}),
  }));
};

const closure = (
  elements = scene(),
  relations: InstructionSemanticRelation[] = [],
  contextId = "context-a",
) =>
  compileInstructionClosure({
    contextId,
    instructionElementId: "instruction",
    elements,
    relations,
    resolveContextId: (element) =>
      element.frameId === "frame" || element.id === "frame" ? contextId : null,
  });

describe("Instruction Semantic Closure", () => {
  it("does not make ordinary board content an instruction", () => {
    expect(() => closure(scene({ instruction: { isDeleted: true } }))).toThrow(
      new InstructionClosureError("INSTRUCTION_MISSING", "Instruction element does not exist."),
    );
  });

  it("invalidates a prior approval after even a one-character instruction edit", () => {
    const approved = closure();
    const edited = closure(
      scene({ instruction: { originalText: "Deploy the plans", text: "Deploy the plans" } }),
    );
    expect(edited.semanticHash).not.toBe(approved.semanticHash);
    expect(edited.closureHash).not.toBe(approved.closureHash);
  });

  it("keeps representation-equivalent line endings and Unicode stable", () => {
    const approved = closure(
      scene({ instruction: { originalText: "café\nDeploy", text: "café\nDeploy" } }),
    );
    const equivalent = closure(
      scene({ instruction: { originalText: "cafe\u0301\r\nDeploy", text: "wrapped" } }),
    );
    expect(equivalent.closureHash).toBe(approved.closureHash);
  });

  it("does not invalidate approval for geometry, style, z-index, or nearby content", () => {
    const approved = closure();
    const cosmetic = closure(
      scene({
        instruction: {
          x: 200,
          y: 90,
          width: 280,
          height: 90,
          strokeColor: "#ff0000",
          index: "zzz",
        },
        unrelated: { originalText: "A new nearby note", text: "A new nearby note" },
      }),
    );
    expect(cosmetic.closureHash).toBe(approved.closureHash);
  });

  it("does not invalidate approval for content in an unreferenced frame", () => {
    const elements = [
      ...scene(),
      { id: "other-frame", type: "frame", x: 500, y: 0, width: 400, height: 300 },
      {
        id: "other-content",
        type: "text",
        frameId: "other-frame",
        originalText: "Unrelated planning note",
        text: "Unrelated planning note",
      },
    ];
    const compile = (updatedElements: Element[]) =>
      compileInstructionClosure({
        contextId: "context-a",
        instructionElementId: "instruction",
        elements: updatedElements,
        relations: [],
        resolveContextId: (element) =>
          element.id === "frame" ||
          element.id === "other-frame" ||
          element.frameId === "frame" ||
          element.frameId === "other-frame"
            ? "context-a"
            : null,
      });
    const approved = compile(elements);
    const changed = compile(
      elements.map((element) =>
        element.id === "other-content"
          ? { ...element, originalText: "Completely different unrelated note" }
          : element,
      ),
    );
    expect(changed.closureHash).toBe(approved.closureHash);
  });

  it("rejects a previously approvable instruction moved to another Agent Context", () => {
    expect(() =>
      compileInstructionClosure({
        contextId: "context-a",
        instructionElementId: "instruction",
        elements: scene(),
        relations: [],
        resolveContextId: (element) =>
          element.id === "instruction"
            ? "context-b"
            : element.frameId === "frame" || element.id === "frame"
              ? "context-a"
              : null,
      }),
    ).toThrow(/not in the named Agent Context/);
  });

  it("binds typed dependencies transitively and ignores an untyped arrow", () => {
    const relations: InstructionSemanticRelation[] = [
      { fromElementId: "instruction", toElementId: "plan", kind: "references" },
    ];
    const approved = closure(scene(), relations);
    const changedDependency = closure(
      scene({ plan: { originalText: "Do not run tests", text: "Do not run tests" } }),
      relations,
    );
    expect(changedDependency.closureHash).not.toBe(approved.closureHash);

    const withUntypedArrow = closure(
      [
        ...scene(),
        {
          id: "arrow",
          type: "arrow",
          frameId: "frame",
          startBinding: { elementId: "instruction" },
          endBinding: { elementId: "unrelated" },
        },
      ],
      relations,
    );
    expect(withUntypedArrow.closureHash).toBe(approved.closureHash);
  });

  it.each(["depends_on", "group"] as const)("binds a %s relation", (kind) => {
    const relations: InstructionSemanticRelation[] = [
      { fromElementId: "instruction", toElementId: "plan", kind },
    ];
    const approved = closure(scene(), relations);
    const changed = closure(
      scene({ plan: { originalText: "Changed dependency", text: "Changed dependency" } }),
      relations,
    );
    expect(changed.closureHash).not.toBe(approved.closureHash);
  });

  it("binds every member of an explicitly referenced whole frame", () => {
    const relations: InstructionSemanticRelation[] = [
      { fromElementId: "instruction", toElementId: "frame", kind: "whole_frame" },
    ];
    const approved = closure(scene(), relations);
    const changed = closure(
      scene({ plan: { originalText: "Changed plan", text: "Changed plan" } }),
      relations,
    );
    expect(changed.closureHash).not.toBe(approved.closureHash);
  });

  it("expands chained whole-frame relations until every reachable frame member is bound", () => {
    const elements = [
      ...scene(),
      { id: "frame-two", type: "frame", x: 500, y: 0, width: 400, height: 300 },
      {
        id: "nested-plan",
        type: "text",
        frameId: "frame-two",
        originalText: "Deploy after verification",
        text: "Deploy after verification",
      },
    ];
    const relations: InstructionSemanticRelation[] = [
      { fromElementId: "instruction", toElementId: "frame", kind: "whole_frame" },
      { fromElementId: "plan", toElementId: "frame-two", kind: "whole_frame" },
    ];
    const compile = (updatedElements: Element[]) =>
      compileInstructionClosure({
        contextId: "context-a",
        instructionElementId: "instruction",
        elements: updatedElements,
        relations,
        resolveContextId: (element) =>
          element.id === "frame" ||
          element.id === "frame-two" ||
          element.frameId === "frame" ||
          element.frameId === "frame-two"
            ? "context-a"
            : null,
      });

    const approved = compile(elements);
    const changed = compile(
      elements.map((element) =>
        element.id === "nested-plan"
          ? { ...element, originalText: "Deploy only after a second verification" }
          : element,
      ),
    );

    expect(changed.closureHash).not.toBe(approved.closureHash);
  });

  it("is deterministic for duplicate paths and cycles", () => {
    const relations: InstructionSemanticRelation[] = [
      { fromElementId: "instruction", toElementId: "plan", kind: "references" },
      { fromElementId: "plan", toElementId: "instruction", kind: "references" },
      { fromElementId: "instruction", toElementId: "plan", kind: "references" },
    ];
    expect(closure(scene(), relations).closureHash).toBe(
      closure(scene(), [...relations].reverse()).closureHash,
    );
  });

  it("rejects a typed relation that would expand the Context boundary", () => {
    const elements = [
      ...scene(),
      { id: "foreign", type: "text", originalText: "secret", text: "secret" },
    ];
    expect(() =>
      compileInstructionClosure({
        contextId: "context-a",
        instructionElementId: "instruction",
        elements,
        relations: [{ fromElementId: "instruction", toElementId: "foreign", kind: "references" }],
        resolveContextId: (element) =>
          element.id === "foreign"
            ? "context-b"
            : element.frameId === "frame" || element.id === "frame"
              ? "context-a"
              : null,
      }),
    ).toThrow(/may not expand/);
  });

  it("ignores a stale relation outside this instruction's closure", () => {
    const approved = closure();
    const withUnrelatedStaleRelation = closure(scene(), [
      { fromElementId: "unrelated", toElementId: "deleted-target", kind: "references" },
    ]);
    expect(withUnrelatedStaleRelation.closureHash).toBe(approved.closureHash);
  });

  it("names a stale relation that is inside this instruction's closure", () => {
    expect(() =>
      closure(scene(), [
        { fromElementId: "instruction", toElementId: "deleted-target", kind: "references" },
      ]),
    ).toThrow(/instruction -> deleted-target \(references\)/);
  });

  it("refuses a freedraw element as an instruction even when it is inside the Context", () => {
    const revision = {
      elements: JSON.stringify(
        scene({ instruction: { type: "freedraw", originalText: undefined, text: undefined } }),
      ),
      contextMap: JSON.stringify([{ id: "context-a", frameElementId: "frame", pinned: false }]),
      semanticRelations: "[]",
    };
    expect(() =>
      compileInstructionClosureFromRevision({
        revision,
        contextId: "context-a",
        elementId: "instruction",
      }),
    ).toThrow(/Only an authored text element may become an Agent instruction\./);
  });

  it("refuses dispatch status after the approved instruction was changed in the pinned revision", async () => {
    const revision = (instructionText: string) => ({
      id: `revision-${instructionText}`,
      elements: JSON.stringify(
        scene({ instruction: { originalText: instructionText, text: instructionText } }),
      ),
      contextMap: JSON.stringify([{ id: "context-a", frameElementId: "frame", pinned: false }]),
      semanticRelations: "[]",
    });
    const approvedRevision = revision("Deploy the plan");
    const approvedClosure = compileInstructionClosureFromRevision({
      revision: approvedRevision,
      contextId: "context-a",
      elementId: "instruction",
    });
    const prisma = {
      agentInstructionApproval: {
        findFirst: async () => ({
          id: "approval-1",
          schemaVersion: approvedClosure.schemaVersion,
          semanticHash: approvedClosure.semanticHash,
          closureHash: approvedClosure.closureHash,
          approvedByUserId: "human-1",
          approvedAt: new Date("2026-08-29T00:00:00.000Z"),
        }),
      },
    };

    await expect(
      requireCurrentInstructionApproval({
        prisma,
        drawingId: "drawing-a",
        contextId: "context-a",
        elementId: "instruction",
        revision: revision("Deploy the plans"),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  });
});
