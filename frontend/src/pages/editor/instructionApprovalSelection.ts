import type { InstructionContext } from "../../api/instructionApprovals";
import { isOnlySelectedElement } from "./floatingToolbarGeometry";

export type InstructionSceneElement = {
  id: string;
  type: string;
  frameId?: string | null;
  originalText?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
};

export type InstructionCandidate = { element: InstructionSceneElement; contextId: string };

/** Local selection is presentation only; the server validates Context membership. */
export const instructionCandidateForSelection = (
  elements: readonly InstructionSceneElement[],
  contexts: readonly InstructionContext[],
  selectedElementIds: Record<string, unknown> | undefined,
): InstructionCandidate | null => {
  const selected = elements.find(
    (element) => element.type === "text" && isOnlySelectedElement(selectedElementIds, element.id),
  );
  if (!selected) return null;

  const byId = new Map(elements.map((element) => [element.id, element]));
  const contextByFrame = new Map(contexts.map((context) => [context.frameElementId, context.id]));
  let current: InstructionSceneElement | undefined = selected;
  const visited = new Set<string>();
  while (current?.frameId && !visited.has(current.frameId)) {
    visited.add(current.frameId);
    const contextId = contextByFrame.get(current.frameId);
    if (contextId) return { element: selected, contextId };
    current = byId.get(current.frameId);
  }
  return null;
};
