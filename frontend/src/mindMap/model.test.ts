import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { layoutMindMap, MIND_MAP_LAYOUT_V1 } from "./layout";
import { normalizeMindMap, subtreeElementIds, type MindMapNodeInput } from "./model";

const node = (
  elementId: string,
  parentId: string | null,
  orderKey: string,
  mapId = "map-1",
): MindMapNodeInput => ({ elementId, relation: { mapId, parentId, orderKey } });

const validFixture = (): MindMapNodeInput[] => [
  node("root", null, "root"),
  node("z-child", "root", "same"),
  node("a-child", "root", "same"),
  node("grandchild", "a-child", "first"),
];

describe("mind-map integrity normalization", () => {
  it("sorts siblings by (orderKey, elementId), never by input order", () => {
    const result = normalizeMindMap(validFixture().reverse(), "map-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.root.children.map((child) => child.elementId)).toEqual([
      "a-child",
      "z-child",
    ]);
    expect(result.value.nodes.map((entry) => entry.elementId)).toEqual([
      "root",
      "a-child",
      "grandchild",
      "z-child",
    ]);
    expect(subtreeElementIds(result.value, "a-child")).toEqual(["a-child", "grandchild"]);
  });

  it.each([
    {
      name: "a missing parent",
      nodes: [node("root", null, "root"), node("child", "gone", "a")],
      code: "missing-parent",
    },
    {
      name: "a parent from another map",
      nodes: [
        node("root", null, "root"),
        node("child", "foreign-root", "a"),
        node("foreign-root", null, "root", "map-2"),
      ],
      code: "cross-map-parent",
    },
    {
      name: "multiple roots",
      nodes: [node("root-a", null, "a"), node("root-b", null, "b")],
      code: "multiple-roots",
    },
    {
      name: "a cycle",
      nodes: [node("root", null, "root"), node("a", "b", "a"), node("b", "a", "b")],
      code: "cycle",
    },
  ])("fails closed and preserves ordinary scene data for $name", ({ nodes, code }) => {
    const before = JSON.stringify(nodes);
    const result = normalizeMindMap(nodes, "map-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.behavior).toBe("preserve-scene");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
    expect(JSON.stringify(nodes)).toBe(before);
  });

  it("reports a rootless cycle deterministically instead of inventing a root", () => {
    const result = normalizeMindMap([node("b", "a", "b"), node("a", "b", "a")], "map-1");

    expect(result).toEqual({
      ok: false,
      mapId: "map-1",
      behavior: "preserve-scene",
      diagnostics: [
        { code: "cycle", elementIds: ["a", "b"] },
        { code: "missing-root", elementIds: ["a", "b"] },
      ],
    });
  });

  it("treats a duplicate element id as invalid rather than choosing one client implicitly", () => {
    const result = normalizeMindMap(
      [node("root", null, "a"), node("same", "root", "a"), node("same", "root", "b")],
      "map-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "duplicate-element",
      elementIds: ["same"],
    });
  });
});

describe("deterministic mind-map layout", () => {
  it("keeps the root anchor fixed and lays a wide fixture left-to-right", () => {
    const normalized = normalizeMindMap(
      [
        node("root", null, "root"),
        node("child-c", "root", "c"),
        node("child-a", "root", "a"),
        node("child-b", "root", "b"),
      ],
      "map-1",
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    expect(layoutMindMap(normalized.value, MIND_MAP_LAYOUT_V1, { x: 100, y: 400 })).toEqual([
      { elementId: "root", x: 100, y: 400 },
      { elementId: "child-a", x: 420, y: 280 },
      { elementId: "child-b", x: 420, y: 400 },
      { elementId: "child-c", x: 420, y: 520 },
    ]);
  });

  it("lays out a deep fixture at a fixed level step", () => {
    const normalized = normalizeMindMap(
      [node("root", null, "root"), node("child", "root", "a"), node("leaf", "child", "a")],
      "map-1",
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    expect(layoutMindMap(normalized.value, MIND_MAP_LAYOUT_V1, { x: -20, y: 15 })).toEqual([
      { elementId: "root", x: -20, y: 15 },
      { elementId: "child", x: 300, y: 15 },
      { elementId: "leaf", x: 620, y: 15 },
    ]);
  });

  it("property: input order and colliding order keys cannot change bits or sibling order", () => {
    const permutation = fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6], {
      minLength: 7,
      maxLength: 7,
    });

    fc.assert(
      fc.property(permutation, (order) => {
        const nodes = [
          node("root", null, "same"),
          node("alpha", "root", "same"),
          node("beta", "root", "same"),
          node("gamma", "root", "same"),
          node("alpha-1", "alpha", "same"),
          node("alpha-2", "alpha", "same"),
          node("beta-1", "beta", "same"),
        ];
        const shuffled = order.map((index) => nodes[index]);
        const first = normalizeMindMap(nodes, "map-1");
        const second = normalizeMindMap(shuffled, "map-1");
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (!first.ok || !second.ok) return;

        const anchor = { x: 123.5, y: -456.25 };
        const firstBits = JSON.stringify(layoutMindMap(first.value, MIND_MAP_LAYOUT_V1, anchor));
        const secondBits = JSON.stringify(layoutMindMap(second.value, MIND_MAP_LAYOUT_V1, anchor));
        expect(secondBits).toBe(firstBits);
        expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
      }),
      { numRuns: 250 },
    );
  });

  it("rejects viewport-like invalid configuration instead of producing NaN coordinates", () => {
    const normalized = normalizeMindMap([node("root", null, "root")], "map-1");
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    expect(() =>
      layoutMindMap(
        normalized.value,
        { ...MIND_MAP_LAYOUT_V1, levelGap: Number.NaN },
        { x: 0, y: 0 },
      ),
    ).toThrow("levelGap");
  });
});
