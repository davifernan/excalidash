import { describe, expect, it } from "vitest";
import { approvalSceneKey } from "./EditorView";

describe("approvalSceneKey", () => {
  const elements = [
    {
      id: "instruction",
      x: 100,
      y: 200,
      width: 180,
      height: 40,
      frameId: "frame-a",
      originalText: "Deploy after review",
    },
  ];

  it("changes when the selected instruction is panned or zoomed", () => {
    const selected = { selectedElementIds: { instruction: true } };
    const initial = approvalSceneKey(elements, {
      ...selected,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    });
    const panned = approvalSceneKey(elements, {
      ...selected,
      scrollX: 80,
      scrollY: -40,
      zoom: { value: 1 },
    });
    const zoomed = approvalSceneKey(elements, {
      ...selected,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1.5 },
    });

    expect(panned).not.toBe(initial);
    expect(zoomed).not.toBe(initial);
  });
});
