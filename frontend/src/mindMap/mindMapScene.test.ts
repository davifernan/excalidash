import { describe, expect, it } from "vitest";
import type { ElementSummary } from "../integrations/excalidraw/types";
import { withExcalidashData } from "../integrations/excalidraw/customData";
import { addNodeOps, arrangeOps, readMindMapEdges, readMindMapNodes } from "./mindMapScene";
import { MIND_MAP_LAYOUT_V1 } from "./layout";

let counter = 0;
const nextId = () => `el-${++counter}`;

function nodeSummary(
  id: string,
  x: number,
  y: number,
  relation: { mapId: string; parentId: string | null; orderKey: string },
): ElementSummary {
  return {
    id: id as never,
    type: "rectangle",
    x,
    y,
    width: MIND_MAP_LAYOUT_V1.nodeWidth,
    height: MIND_MAP_LAYOUT_V1.nodeHeight,
    angle: 0,
    isDeleted: false,
    frameId: null,
    containerId: null,
    link: null,
    customData: withExcalidashData({}, { mindMap: relation }) as any,
  } as ElementSummary;
}

function edgeSummary(id: string, mapId: string, childId: string): ElementSummary {
  return {
    id: id as never,
    type: "arrow",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    angle: 0,
    isDeleted: false,
    frameId: null,
    containerId: null,
    link: null,
    customData: withExcalidashData({}, { mindMapProjection: { mapId, childId } }) as any,
  } as ElementSummary;
}

describe("addNodeOps", () => {
  it("adds a child under the anchor and lays out the whole map in one batch", () => {
    const mapId = "map-1";
    const root = nodeSummary(nextId(), 100, 100, { mapId, parentId: null, orderKey: "m" });
    const summaries = [root];

    const result = addNodeOps(summaries, "child", root.id as unknown as string);
    expect(result).not.toBeNull();
    const insertOp = result!.ops.find((op) => op.kind === "insert" && (op.elements[0] as any).id === result!.newNodeId);
    expect(insertOp).toBeDefined();
    // Root itself never moves for its own first child (nothing else on its level).
    const rootPatch = result!.ops.find((op) => op.kind === "patch" && op.id === root.id);
    expect(rootPatch).toBeUndefined();
  });

  it("adds a sibling under the same parent, never as a second root", () => {
    const mapId = "map-2";
    const rootId = nextId();
    const childId = nextId();
    const root = nodeSummary(rootId, 0, 0, { mapId, parentId: null, orderKey: "m" });
    const child = nodeSummary(childId, 300, 0, { mapId, parentId: rootId, orderKey: "m" });
    const summaries = [root, child];

    const result = addNodeOps(summaries, "sibling", childId);
    expect(result).not.toBeNull();

    const inserted = result!.ops.find(
      (op) => op.kind === "insert" && (op.elements[0] as any).id === result!.newNodeId,
    ) as any;
    const relation = inserted.elements[0].customData.excalidash.mindMap;
    expect(relation.parentId).toBe(rootId);
    expect(relation.mapId).toBe(mapId);
  });

  it("Enter on the root adds a child, not a second root (explicit decision, NIL-570)", () => {
    const mapId = "map-3";
    const rootId = nextId();
    const root = nodeSummary(rootId, 0, 0, { mapId, parentId: null, orderKey: "m" });

    const result = addNodeOps([root], "sibling", rootId);
    expect(result).not.toBeNull();
    const inserted = result!.ops.find(
      (op) => op.kind === "insert" && (op.elements[0] as any).id === result!.newNodeId,
    ) as any;
    expect(inserted.elements[0].customData.excalidash.mindMap.parentId).toBe(rootId);
  });

  it("returns null for an anchor that isn't a mind-map node", () => {
    expect(addNodeOps([], "child", "nope")).toBeNull();
  });

  /**
   * Counter-test: break the enforcement by reverting to "always attach the
   * new node under the clicked anchor, regardless of Tab vs Enter" -- a
   * plausible-looking bug where the sibling branch is dropped. Copied here,
   * not `git checkout --`'d, per NIL-570's evidence rule.
   */
  it("regression guard: a build that ignores kind and always adds a child would fail the sibling assertion above", () => {
    const alwaysChild = (
      summaries: readonly ElementSummary[],
      _kind: "child" | "sibling",
      anchorId: string,
    ) => addNodeOps(summaries, "child", anchorId);

    const mapId = "map-4";
    const rootId = nextId();
    const childId = nextId();
    const root = nodeSummary(rootId, 0, 0, { mapId, parentId: null, orderKey: "m" });
    const child = nodeSummary(childId, 300, 0, { mapId, parentId: rootId, orderKey: "m" });

    const broken = alwaysChild([root, child], "sibling", childId)!;
    const insertedBroken = broken.ops.find(
      (op) => op.kind === "insert" && (op.elements[0] as any).id === broken.newNodeId,
    ) as any;
    // Under the bug, "sibling of child" becomes "child of child" -- wrong.
    expect(insertedBroken.elements[0].customData.excalidash.mindMap.parentId).toBe(childId);

    const correct = addNodeOps([root, child], "sibling", childId)!;
    const insertedCorrect = correct.ops.find(
      (op) => op.kind === "insert" && (op.elements[0] as any).id === correct.newNodeId,
    ) as any;
    expect(insertedCorrect.elements[0].customData.excalidash.mindMap.parentId).toBe(rootId);
  });
});

describe("arrangeOps", () => {
  it("replaces every projection edge for the map and repositions nodes deterministically", () => {
    const mapId = "map-5";
    const rootId = nextId();
    const aId = nextId();
    const bId = nextId();
    const root = nodeSummary(rootId, 0, 0, { mapId, parentId: null, orderKey: "m" });
    // Deliberately mis-positioned children -- arrange should move them.
    const a = nodeSummary(aId, 9999, 9999, { mapId, parentId: rootId, orderKey: "a" });
    const b = nodeSummary(bId, -50, -50, { mapId, parentId: rootId, orderKey: "m" });
    const staleEdge = edgeSummary(nextId(), mapId, aId);
    const summaries = [root, a, b, staleEdge];

    const ops = arrangeOps(summaries, mapId)!;
    expect(ops).not.toBeNull();

    const removed = ops.find((op) => op.kind === "remove") as any;
    expect(removed.ids).toContain(staleEdge.id);

    const inserted = ops.filter((op) => op.kind === "insert").flatMap((op: any) => op.elements);
    expect(inserted).toHaveLength(2); // one edge per child of root

    const patched = ops.filter((op) => op.kind === "patch");
    expect(patched.some((op: any) => op.id === aId)).toBe(true);
    expect(patched.some((op: any) => op.id === bId)).toBe(true);
  });

  it("returns null for a map with an unresolved integrity problem (cycle, orphan, ...)", () => {
    const mapId = "map-6";
    const aId = nextId();
    const bId = nextId();
    // a's parent is b, b's parent is a: a cycle, no valid root.
    const a = nodeSummary(aId, 0, 0, { mapId, parentId: bId, orderKey: "m" });
    const b = nodeSummary(bId, 0, 0, { mapId, parentId: aId, orderKey: "m" });

    expect(arrangeOps([a, b], mapId)).toBeNull();
  });

  it("is a no-op when the map is already at its deterministic layout", () => {
    const mapId = "map-7";
    const rootId = nextId();
    const root = nodeSummary(rootId, 0, 0, { mapId, parentId: null, orderKey: "m" });
    const ops = arrangeOps([root], mapId)!;
    // No edges, no children, nothing to patch or replace.
    expect(ops).toEqual([]);
  });

  it("moves a node's bound label by the same delta as the node itself", () => {
    const mapId = "map-9";
    const rootId = nextId();
    const childId = nextId();
    const labelId = nextId();
    const root = nodeSummary(rootId, 0, 0, { mapId, parentId: null, orderKey: "m" });
    // Mis-positioned so arrange has to move it -- label offset by (10, 30)
    // from its container, the kind of offset Excalidraw's own centering
    // produces and this code must never assume is (0, 0).
    const child = nodeSummary(childId, 9999, 9999, { mapId, parentId: rootId, orderKey: "m" });
    const label = { ...child, id: labelId as never, type: "text", containerId: childId, x: 10009, y: 10029 };
    const summaries = [root, child, label] as ElementSummary[];

    const ops = arrangeOps(summaries, mapId)!;
    const childPatch = ops.find((op) => op.kind === "patch" && op.id === childId) as any;
    const labelPatch = ops.find((op) => op.kind === "patch" && op.id === labelId) as any;
    expect(childPatch).toBeDefined();
    expect(labelPatch).toBeDefined();
    expect(labelPatch.changes.x - label.x).toBe(childPatch.changes.x - child.x);
    expect(labelPatch.changes.y - label.y).toBe(childPatch.changes.y - child.y);
  });

  /**
   * Counter-test: break the enforcement by reverting to the version that
   * only patched the container, leaving its bound label behind -- exactly
   * the bug a real browser run (mind-map.spec.ts's drag-test screenshots)
   * caught and this file's jsdom tests could not, since jsdom has no layout
   * engine to notice a label sitting in the wrong place.
   */
  it("regression guard: patching only the container would leave the label unpatched", () => {
    const mapId = "map-10";
    const rootId = nextId();
    const childId = nextId();
    const labelId = nextId();
    const root = nodeSummary(rootId, 0, 0, { mapId, parentId: null, orderKey: "m" });
    const child = nodeSummary(childId, 9999, 9999, { mapId, parentId: rootId, orderKey: "m" });
    const label = { ...child, id: labelId as never, type: "text", containerId: childId, x: 10009, y: 10029 };
    const summaries = [root, child, label] as ElementSummary[];

    const ops = arrangeOps(summaries, mapId)!;
    const withoutLabelPatch = ops.filter((op) => !(op.kind === "patch" && op.id === labelId));
    expect(withoutLabelPatch.some((op) => op.kind === "patch" && op.id === labelId)).toBe(false);
    expect(ops.some((op) => op.kind === "patch" && op.id === labelId)).toBe(true);
  });
});

describe("readMindMapNodes / readMindMapEdges", () => {
  it("ignores deleted elements and elements without the customData record", () => {
    const mapId = "map-8";
    const live = nodeSummary(nextId(), 0, 0, { mapId, parentId: null, orderKey: "m" });
    const deleted = { ...nodeSummary(nextId(), 0, 0, { mapId, parentId: null, orderKey: "m" }), isDeleted: true };
    const plain = { ...live, id: nextId() as any, customData: null };

    const nodes = readMindMapNodes([live, deleted, plain] as ElementSummary[]);
    expect(nodes.map((node) => node.summary.id)).toEqual([live.id]);

    const edges = readMindMapEdges([live] as ElementSummary[]);
    expect(edges.size).toBe(0);
  });
});
