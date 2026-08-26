import { describe, expect, it } from "vitest";
import {
  layoutMindMap,
  MIND_MAP_LAYOUT_V1,
  type MindMapTree,
  type MindMapTreeNode,
} from "./layout";

/** Builds a MindMapTree from a flat {id, children} shorthand. */
const tree = (root: MindMapTreeNode): MindMapTree => {
  const nodes: MindMapTreeNode[] = [];
  const visit = (node: MindMapTreeNode) => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return { root, nodes };
};

describe("deterministic mind-map layout (NIL-593, Schnitt 2: model.ts's own tests, ported off a plain tree)", () => {
  it("keeps the root anchor fixed and lays a wide fixture left-to-right", () => {
    const map = tree({
      elementId: "root",
      children: [
        { elementId: "child-a", children: [] },
        { elementId: "child-b", children: [] },
        { elementId: "child-c", children: [] },
      ],
    });

    expect(layoutMindMap(map, MIND_MAP_LAYOUT_V1, { x: 100, y: 400 })).toEqual([
      { elementId: "root", x: 100, y: 400 },
      { elementId: "child-a", x: 420, y: 280 },
      { elementId: "child-b", x: 420, y: 400 },
      { elementId: "child-c", x: 420, y: 520 },
    ]);
  });

  it("lays out a deep fixture at a fixed level step", () => {
    const map = tree({
      elementId: "root",
      children: [
        {
          elementId: "child",
          children: [{ elementId: "leaf", children: [] }],
        },
      ],
    });

    expect(layoutMindMap(map, MIND_MAP_LAYOUT_V1, { x: -20, y: 15 })).toEqual([
      { elementId: "root", x: -20, y: 15 },
      { elementId: "child", x: 300, y: 15 },
      { elementId: "leaf", x: 620, y: 15 },
    ]);
  });

  it("rejects viewport-like invalid configuration instead of producing NaN coordinates", () => {
    const map = tree({ elementId: "root", children: [] });

    expect(() =>
      layoutMindMap(map, { ...MIND_MAP_LAYOUT_V1, levelGap: Number.NaN }, { x: 0, y: 0 }),
    ).toThrow("levelGap");
  });

  it("is a pure function of tree shape and anchor -- same input, same bits", () => {
    const map = tree({
      elementId: "root",
      children: [
        { elementId: "a", children: [{ elementId: "a1", children: [] }] },
        { elementId: "b", children: [] },
      ],
    });
    const anchor = { x: 123.5, y: -456.25 };
    const first = JSON.stringify(layoutMindMap(map, MIND_MAP_LAYOUT_V1, anchor));
    const second = JSON.stringify(layoutMindMap(map, MIND_MAP_LAYOUT_V1, anchor));
    expect(second).toBe(first);
  });
});
