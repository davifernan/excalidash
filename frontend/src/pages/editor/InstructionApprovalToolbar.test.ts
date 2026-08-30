import { describe, expect, it } from "vitest";
import { instructionCandidateForSelection } from "./instructionApprovalSelection";

const element = (id: string, type: string, frameId?: string) => ({
  id,
  type,
  frameId,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  angle: 0,
});

describe("instruction approval toolbar selection", () => {
  const elements = [
    element("context-frame", "frame"),
    element("instruction", "text", "context-frame"),
    element("other", "text", "context-frame"),
  ];
  const contexts = [{ id: "context-a", frameElementId: "context-frame" }];

  it("anchors only a single selected text element inside a server-listed Context", () => {
    expect(
      instructionCandidateForSelection(elements, contexts, { instruction: true }),
    ).toMatchObject({
      contextId: "context-a",
      element: { id: "instruction" },
    });
    expect(
      instructionCandidateForSelection(elements, contexts, { instruction: true, other: true }),
    ).toBe(null);
    expect(instructionCandidateForSelection(elements, [], { instruction: true })).toBe(null);
  });
});
