import { describe, expect, it } from "vitest";
import {
  collapsedHiddenIds,
  collapsedNodeIds,
  pinnedNodeIds,
  toggleCollapseOps,
  togglePinOps,
} from "./nodeState";
import { readNodeState, withExcalidashData } from "../integrations/excalidraw/customData";
import type { ElementId, ElementSummary } from "../integrations/excalidraw/types";

const summary = (over: Partial<ElementSummary> = {}): ElementSummary => ({
  id: "e1" as ElementId,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  angle: 0,
  opacity: 100,
  isDeleted: false,
  frameId: null,
  containerId: null,
  link: null,
  customData: null,
  name: null,
  boundElements: null,
  startBinding: null,
  endBinding: null,
  ...over,
});

const arrow = (
  id: string,
  startId: string | null,
  endId: string | null,
  over: Partial<ElementSummary> = {},
): ElementSummary =>
  summary({
    id: id as ElementId,
    type: "arrow",
    startBinding: startId ? { elementId: startId as ElementId } : null,
    endBinding: endId ? { elementId: endId as ElementId } : null,
    ...over,
  });

const node = (
  id: string,
  x: number,
  y: number,
  over: Partial<ElementSummary> = {},
): ElementSummary => summary({ id: id as ElementId, x, y, ...over });

const pinned = (id: string, x: number, y: number): ElementSummary =>
  node(id, x, y, { customData: withExcalidashData(null, { nodeState: { pinned: true } }) });

const chain = () => [
  node("root", 0, 0),
  node("a", 300, 0),
  node("b", 600, 0),
  arrow("e1", "root", "a"),
  arrow("e2", "a", "b"),
];

describe("pinnedNodeIds / collapsedNodeIds", () => {
  it("reads pinned/collapsed off nodeState, not the dying mindMap shape", () => {
    const summaries = [
      pinned("a", 0, 0),
      node("b", 0, 0, {
        customData: withExcalidashData(null, { nodeState: { collapsed: true } }),
      }),
      node("c", 0, 0),
    ];
    expect(pinnedNodeIds(summaries)).toEqual(new Set(["a"]));
    expect(collapsedNodeIds(summaries)).toEqual(new Set(["b"]));
  });

  it("ignores a deleted element even if its nodeState says pinned", () => {
    const summaries = [pinned("a", 0, 0)].map((element) => ({ ...element, isDeleted: true }));
    expect(pinnedNodeIds(summaries)).toEqual(new Set());
  });
});

describe("togglePinOps", () => {
  it("pins an unpinned node, one patch op", () => {
    const summaries = [node("a", 0, 0)];
    const ops = togglePinOps(summaries, "a")!;
    expect(ops).toHaveLength(1);
    const patched = { customData: (ops[0] as any).changes.customData };
    expect(readNodeState(patched)?.pinned).toBe(true);
  });

  it("unpinning does not silently drop an existing collapsed flag", () => {
    const summaries = [
      node("a", 0, 0, {
        customData: withExcalidashData(null, { nodeState: { pinned: true, collapsed: true } }),
      }),
    ];
    const ops = togglePinOps(summaries, "a")!;
    const patched = { customData: (ops[0] as any).changes.customData };
    expect(readNodeState(patched)).toEqual({ collapsed: true });
  });

  it("null for an unknown node", () => {
    expect(togglePinOps([node("a", 0, 0)], "does-not-exist")).toBeNull();
  });

  it("nudges opacity by exactly one point, symmetrically on pin and unpin -- the undo-compatibility fix, see this module's own header comment", () => {
    const summaries = [node("a", 0, 0, { opacity: 100 })];
    const pinOps = togglePinOps(summaries, "a")!;
    expect((pinOps[0] as any).changes.opacity).toBe(99);

    const pinnedSummaries = [
      node("a", 0, 0, {
        opacity: 99,
        customData: withExcalidashData(null, { nodeState: { pinned: true } }),
      }),
    ];
    const unpinOps = togglePinOps(pinnedSummaries, "a")!;
    expect((unpinOps[0] as any).changes.opacity).toBe(100);
  });

  it("clamps at 0 rather than going negative -- the one documented, narrow gap this module's header comment accepts", () => {
    const summaries = [node("a", 0, 0, { opacity: 0 })];
    const ops = togglePinOps(summaries, "a")!;
    expect((ops[0] as any).changes.opacity).toBe(0);
  });
});

describe("collapsedHiddenIds", () => {
  it("hides the ambient descendants, their labels, and the internal edges -- not the node itself", () => {
    const summaries = [
      ...chain(),
      node("a-label", 300, 0, { containerId: "a" as ElementId, type: "text" as any }),
    ];
    const hidden = collapsedHiddenIds(summaries, "root")!;
    expect(hidden.nodeCount).toBe(2);
    expect(hidden.ids).toEqual(new Set(["a", "b", "a-label", "e1", "e2"]));
    expect(hidden.ids.has("root")).toBe(false);
  });

  it("null for a leaf -- nothing qualifies as a descendant", () => {
    expect(collapsedHiddenIds([node("solo", 0, 0)], "solo")).toBeNull();
  });

  it("null for an unknown node", () => {
    expect(collapsedHiddenIds([node("a", 0, 0)], "does-not-exist")).toBeNull();
  });

  it("respects the same direction-consistency rule as drag-follow -- a decision point hides nothing", () => {
    const summaries = [
      node("hub", 0, 0),
      node("down", 0, 300),
      node("right", 300, 0),
      arrow("e1", "hub", "down"),
      arrow("e2", "hub", "right"),
    ];
    expect(collapsedHiddenIds(summaries, "hub")).toBeNull();
  });
});

describe("toggleCollapseOps", () => {
  it("collapses a node with qualifying children, one patch op", () => {
    const ops = toggleCollapseOps(chain(), "root")!;
    expect(ops).toHaveLength(1);
    const patched = { customData: (ops[0] as any).changes.customData };
    expect(readNodeState(patched)?.collapsed).toBe(true);
  });

  it("refuses to collapse a leaf", () => {
    expect(toggleCollapseOps([node("solo", 0, 0)], "solo")).toBeNull();
  });

  it("un-collapsing does not silently drop an existing pinned flag", () => {
    const summaries = [
      ...chain().map((element) =>
        element.id === "root"
          ? {
              ...element,
              customData: withExcalidashData(null, {
                nodeState: { pinned: true, collapsed: true },
              }),
            }
          : element,
      ),
    ];
    const ops = toggleCollapseOps(summaries, "root")!;
    const patched = { customData: (ops[0] as any).changes.customData };
    expect(readNodeState(patched)).toEqual({ pinned: true });
  });
});
