import { describe, expect, it } from "vitest";
import { buildElements } from "../integrations/excalidraw/elements";
import { createMindMapEdge, mergeEdgeBinding } from "./mindMapElements";

describe("createMindMapEdge", () => {
  it("produces a real bound arrow, startBinding/endBinding pointing at the given ids", () => {
    const arrow = createMindMapEdge(
      "edge-1",
      "map-1",
      { id: "parent-1", x: 0, y: 0, width: 200, height: 80 },
      { id: "child-1", x: 300, y: 0, width: 200, height: 80 },
    );
    expect(arrow.type).toBe("arrow");
    expect(arrow.id).toBe("edge-1");
    expect(arrow.startBinding?.elementId).toBe("parent-1");
    expect(arrow.endBinding?.elementId).toBe("child-1");
    expect(arrow.customData.excalidash.mindMapProjection).toEqual({
      mapId: "map-1",
      childId: "child-1",
    });
  });

  /**
   * Counter-test: break the enforcement by reverting to a version that
   * builds the arrow alone, without describing the parent/child boxes in
   * the same conversion batch -- the exact one-sided-binding shape NIL-570
   * deliberately avoided and NIL-575 exists to replace. Copied here, not
   * `git checkout --`'d.
   */
  it("regression guard: building the arrow alone (no same-batch boxes) leaves it unbound", () => {
    // Mirrors the pre-NIL-575 shape: same package call, but only the arrow
    // skeleton, no parent/child description alongside it.
    const [broken] = buildElements(
      [
        {
          id: "edge-2",
          type: "arrow",
          x: 0,
          y: 0,
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
      { regenerateIds: false },
    );
    expect(broken.startBinding).toBeFalsy();
    expect(broken.endBinding).toBeFalsy();

    const bound = createMindMapEdge(
      "edge-3",
      "map-1",
      { id: "parent-2", x: 0, y: 0, width: 200, height: 80 },
      { id: "child-2", x: 300, y: 0, width: 200, height: 80 },
    );
    expect(bound.startBinding?.elementId).toBe("parent-2");
  });
});

describe("mergeEdgeBinding", () => {
  it("keeps foreign entries (a bound label), drops removed edges, adds new ones", () => {
    const current = [
      { id: "label-1", type: "text" as const },
      { id: "old-edge", type: "arrow" as const },
    ];
    const result = mergeEdgeBinding(current, new Set(["old-edge"]), [
      { id: "new-edge", type: "arrow" },
    ]);
    expect(result).toEqual([
      { id: "label-1", type: "text" },
      { id: "new-edge", type: "arrow" },
    ]);
  });

  it("starts from an empty list when the shape had none yet", () => {
    expect(mergeEdgeBinding(null, new Set(), [{ id: "edge-1", type: "arrow" }])).toEqual([
      { id: "edge-1", type: "arrow" },
    ]);
  });

  it("never duplicates a ref that survives and is also being re-added", () => {
    const current = [{ id: "edge-1", type: "arrow" as const }];
    const result = mergeEdgeBinding(current, new Set(), [{ id: "edge-1", type: "arrow" }]);
    expect(result).toEqual([{ id: "edge-1", type: "arrow" }]);
  });

  /**
   * Counter-test: break the enforcement by reverting to a version that
   * always appends without filtering removed ids -- a plausible half-fix
   * that leaves a stale reference to a deleted arrow sitting in
   * `boundElements`, exactly the "foreign-referencing structure" NIL-570's
   * own integrity rule forbids.
   */
  it("regression guard: appending without filtering would keep the stale edge", () => {
    const alwaysAppend = (
      current: readonly { id: string; type: "arrow" | "text" }[] | null,
      _remove: ReadonlySet<string>,
      add: readonly { id: string; type: "arrow" | "text" }[],
    ) => [...(current ?? []), ...add];

    const current = [{ id: "old-edge", type: "arrow" as const }];
    const broken = alwaysAppend(current, new Set(["old-edge"]), [
      { id: "new-edge", type: "arrow" },
    ]);
    expect(broken.some((ref) => ref.id === "old-edge")).toBe(true);

    const correct = mergeEdgeBinding(current, new Set(["old-edge"]), [
      { id: "new-edge", type: "arrow" },
    ]);
    expect(correct.some((ref) => ref.id === "old-edge")).toBe(false);
  });
});
