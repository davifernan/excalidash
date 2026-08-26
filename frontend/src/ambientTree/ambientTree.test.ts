import { describe, expect, it } from "vitest";
import {
  ambientSubtreeIds,
  ambientTreeRootedAt,
  type AmbientTreeNode,
  type ArrowEdge,
  type ShapeBox,
} from "./ambientTree";

/** Flattens an AmbientTreeNode to id -> sorted child ids, for order-independent comparison. */
const shapeOf = (node: AmbientTreeNode): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  const visit = (n: AmbientTreeNode) => {
    out[n.id] = n.children.map((c) => c.id).sort();
    n.children.forEach(visit);
  };
  visit(node);
  return out;
};

const box = (id: string, x: number, y: number, width = 200, height = 80): ShapeBox => ({
  id,
  x,
  y,
  width,
  height,
});

const edge = (arrowId: string, startId: string | null, endId: string | null): ArrowEdge => ({
  arrowId,
  startId,
  endId,
});

const boxesOf = (boxes: readonly ShapeBox[]): ReadonlyMap<string, ShapeBox> =>
  new Map(boxes.map((b) => [b.id, b]));

describe("ambientSubtreeIds: a genuine tree", () => {
  it("follows a whole branching subtree, recursively", () => {
    // Root -> A, Root -> B, A -> A1. All children to the right of their parent.
    const boxes = [box("root", 0, 100), box("a", 300, 0), box("b", 300, 200), box("a1", 600, 0)];
    const edges = [edge("e1", "root", "a"), edge("e2", "root", "b"), edge("e3", "a", "a1")];

    const result = ambientSubtreeIds("root", edges, boxesOf(boxes));
    expect(result).toEqual(new Set(["a", "b", "a1"]));
  });

  it("dragging a middle node only pulls its own descendants, not its ancestor or siblings", () => {
    const boxes = [box("root", 0, 100), box("a", 300, 0), box("b", 300, 200), box("a1", 600, 0)];
    const edges = [edge("e1", "root", "a"), edge("e2", "root", "b"), edge("e3", "a", "a1")];

    const result = ambientSubtreeIds("a", edges, boxesOf(boxes));
    expect(result).toEqual(new Set(["a1"]));
  });

  it("an unbound arrow (missing a binding on either end) never contributes an edge", () => {
    const boxes = [box("root", 0, 0), box("a", 300, 0)];
    const edges = [edge("e1", "root", null), edge("e2", null, "a")];
    expect(ambientSubtreeIds("root", edges, boxesOf(boxes))).toEqual(new Set());
  });

  it("an incoming arrow never pulls its source along (direction matters)", () => {
    const boxes = [box("root", 0, 0), box("a", 300, 0)];
    // The arrow points INTO root, not out of it.
    const edges = [edge("e1", "a", "root")];
    expect(ambientSubtreeIds("root", edges, boxesOf(boxes))).toEqual(new Set());
  });
});

describe("ambientSubtreeIds: breaking point 1 -- a flowchart's branch/merge is not a tree edge", () => {
  /**
   * The fixture the ticket asks for: a realistic flowchart with a genuine
   * decision point. Start -> Decision -> {Yes goes down, No goes right} ->
   * both merge into End.
   */
  const flowchart = () => {
    const boxes = [
      box("start", 0, 0),
      box("decision", 300, 0),
      box("yes", 300, 300), // straight down from decision
      box("no", 600, 0), // to the right of decision
      box("end", 600, 300),
    ];
    const edges = [
      edge("e-start-decision", "start", "decision"),
      edge("e-decision-yes", "decision", "yes"),
      edge("e-decision-no", "decision", "no"),
      edge("e-yes-end", "yes", "end"),
      edge("e-no-end", "no", "end"),
    ];
    return { boxes, edges };
  };

  it("dragging the decision point pulls neither branch -- directions diverge", () => {
    const { boxes, edges } = flowchart();
    expect(ambientSubtreeIds("decision", edges, boxesOf(boxes))).toEqual(new Set());
  });

  it("the merge point (End) is never pulled by either branch -- it has two incoming edges", () => {
    const { boxes, edges } = flowchart();
    expect(ambientSubtreeIds("yes", edges, boxesOf(boxes)).has("end")).toBe(false);
    expect(ambientSubtreeIds("no", edges, boxesOf(boxes)).has("end")).toBe(false);
  });

  /**
   * The honest, documented gap (see ambientTree.ts's own file comment):
   * Start -> Decision alone is a plain chain link, indistinguishable from a
   * tree edge by shape alone. Dragging Start pulls Decision -- but rule 3
   * (direction consistency) stops it from cascading past Decision into Yes/
   * No/End, which is the part of an existing flowchart that actually
   * matters (nothing downstream of the real branch point moves).
   */
  it("dragging Start pulls the one plain chain link (Decision) but never cascades past the real branch", () => {
    const { boxes, edges } = flowchart();
    const result = ambientSubtreeIds("start", edges, boxesOf(boxes));
    expect(result).toEqual(new Set(["decision"]));
    expect(result.has("yes")).toBe(false);
    expect(result.has("no")).toBe(false);
    expect(result.has("end")).toBe(false);
  });
});

describe("ambientSubtreeIds: breaking point 2 -- a cycle aborts to empty, not a partial drag", () => {
  it("A -> B -> C -> A: dragging A follows nothing, not even B and C", () => {
    const boxes = [box("a", 0, 0), box("b", 300, 0), box("c", 600, 0)];
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")];
    expect(ambientSubtreeIds("a", edges, boxesOf(boxes))).toEqual(new Set());
  });

  it("a self-loop (A -> A) is ignored outright, not treated as a cycle needing an abort", () => {
    const boxes = [box("a", 0, 0), box("b", 300, 0)];
    const edges = [edge("e1", "a", "a"), edge("e2", "a", "b")];
    // The self-loop contributes nothing; the genuine A -> B edge still works.
    expect(ambientSubtreeIds("a", edges, boxesOf(boxes))).toEqual(new Set(["b"]));
  });

  /**
   * Counter-test: break the enforcement by treating "already visited" as a
   * silent skip instead of a whole-result abort -- a plausible-looking BFS
   * that would partially drag B and C on the cycle above instead of
   * nothing. Copied here, not `git checkout --`'d, per NIL-570's evidence
   * rule.
   */
  it("regression guard: skipping an already-visited node instead of aborting would partially drag the cycle", () => {
    const boxes = [box("a", 0, 0), box("b", 300, 0), box("c", 600, 0)];
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")];

    const partialBfs = (start: string) => {
      const outgoing = new Map<string, string[]>();
      for (const e of edges) {
        if (!e.startId || !e.endId) continue;
        outgoing.set(e.startId, [...(outgoing.get(e.startId) ?? []), e.endId]);
      }
      const visited = new Set<string>();
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const child of outgoing.get(current) ?? []) {
          if (visited.has(child) || child === start) continue; // the bug: silent skip, not abort
          visited.add(child);
          queue.push(child);
        }
      }
      return visited;
    };
    // Under the bug, B and C would move.
    expect(partialBfs("a")).toEqual(new Set(["b", "c"]));
    // The real implementation stays silent instead.
    expect(ambientSubtreeIds("a", edges, boxesOf(boxes))).toEqual(new Set());
  });
});

describe("ambientSubtreeIds: breaking point 3 -- two arrows into the same box", () => {
  it("a box with two incoming candidate edges is excluded from both potential parents", () => {
    const boxes = [box("p1", 0, 0), box("p2", 0, 300), box("shared", 300, 150)];
    const edges = [edge("e1", "p1", "shared"), edge("e2", "p2", "shared")];
    expect(ambientSubtreeIds("p1", edges, boxesOf(boxes))).toEqual(new Set());
    expect(ambientSubtreeIds("p2", edges, boxesOf(boxes))).toEqual(new Set());
  });

  it("once a merge is removed, the sole remaining parent regains its child", () => {
    const boxes = [box("p1", 0, 0), box("shared", 300, 0)];
    const edges = [edge("e1", "p1", "shared")];
    expect(ambientSubtreeIds("p1", edges, boxesOf(boxes))).toEqual(new Set(["shared"]));
  });
});

describe("ambientSubtreeIds: direction consistency", () => {
  it("a hub with children spread vertically but all to the right is still consistent", () => {
    const boxes = [
      box("hub", 0, 200),
      box("top", 300, 0),
      box("mid", 300, 200),
      box("bottom", 300, 400),
    ];
    const edges = [edge("e1", "hub", "top"), edge("e2", "hub", "mid"), edge("e3", "hub", "bottom")];
    expect(ambientSubtreeIds("hub", edges, boxesOf(boxes))).toEqual(
      new Set(["top", "mid", "bottom"]),
    );
  });

  it("one child straight down and one straight right is inconsistent -- neither is pulled", () => {
    const boxes = [box("hub", 0, 0), box("down", 0, 300), box("right", 300, 0)];
    const edges = [edge("e1", "hub", "down"), edge("e2", "hub", "right")];
    expect(ambientSubtreeIds("hub", edges, boxesOf(boxes))).toEqual(new Set());
  });
});

// NIL-593, Schnitt 2: "Arrange" needs real parent-child topology, not just
// "which shapes move together" -- ambientTreeRootedAt shares the exact same
// qualifying-children rule as ambientSubtreeIds (same underlying helper),
// so these pin that the two can never disagree.
describe("ambientTreeRootedAt: real tree topology for Arrange", () => {
  it("builds the same branching structure ambientSubtreeIds already follows", () => {
    const boxes = [box("root", 0, 100), box("a", 300, 0), box("b", 300, 200), box("a1", 600, 0)];
    const edges = [edge("e1", "root", "a"), edge("e2", "root", "b"), edge("e3", "a", "a1")];

    const tree = ambientTreeRootedAt("root", edges, boxesOf(boxes));
    expect(tree).not.toBeNull();
    expect(shapeOf(tree!)).toEqual({
      root: ["a", "b"].sort(),
      a: ["a1"],
      b: [],
      a1: [],
    });
  });

  it("a decision point's diverging branches contribute nothing -- root has no children", () => {
    const boxes = [box("hub", 0, 0), box("down", 0, 300), box("right", 300, 0)];
    const edges = [edge("e1", "hub", "down"), edge("e2", "hub", "right")];
    const tree = ambientTreeRootedAt("hub", edges, boxesOf(boxes));
    expect(tree).toEqual({ id: "hub", children: [] });
  });

  it("a flowchart merge point (two incoming edges) is excluded from both would-be parents", () => {
    const boxes = [box("a", 0, 0), box("b", 0, 200), box("merge", 300, 100)];
    const edges = [edge("e1", "a", "merge"), edge("e2", "b", "merge")];
    expect(ambientTreeRootedAt("a", edges, boxesOf(boxes))).toEqual({ id: "a", children: [] });
    expect(ambientTreeRootedAt("b", edges, boxesOf(boxes))).toEqual({ id: "b", children: [] });
  });

  it("returns null on a cycle instead of a partial tree", () => {
    const boxes = [box("a", 0, 0), box("b", 300, 0), box("c", 600, 0)];
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")];
    expect(ambientTreeRootedAt("a", edges, boxesOf(boxes))).toBeNull();
  });

  it("a leaf with no qualifying outgoing edges is a childless root, not null", () => {
    const boxes = [box("solo", 0, 0)];
    expect(ambientTreeRootedAt("solo", [], boxesOf(boxes))).toEqual({ id: "solo", children: [] });
  });
});
