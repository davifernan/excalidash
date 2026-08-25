import { describe, expect, it } from "vitest";
import type { ElementSummary } from "../integrations/excalidraw/types";
import { withExcalidashData } from "../integrations/excalidraw/customData";
import { integrityCleanupOps } from "./useMindMapIntegrity";

let counter = 0;
const nextId = () => `el-${++counter}`;

function nodeSummary(id: string, relation: { mapId: string; parentId: string | null; orderKey: string }): ElementSummary {
  return {
    id: id as never,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
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

describe("integrityCleanupOps", () => {
  it("does nothing to a valid map", () => {
    const mapId = "m1";
    const rootId = nextId();
    const root = nodeSummary(rootId, { mapId, parentId: null, orderKey: "m" });
    expect(integrityCleanupOps([root])).toEqual([]);
  });

  it("removes a child left pointing at a deleted parent, and its own descendants and dangling edge", () => {
    const mapId = "m2";
    const rootId = nextId();
    const childId = nextId();
    const grandchildId = nextId();
    const edgeId = nextId();
    // rootId no longer exists in the scene -- as if it had just been deleted.
    const child = nodeSummary(childId, { mapId, parentId: rootId, orderKey: "m" });
    const grandchild = nodeSummary(grandchildId, { mapId, parentId: childId, orderKey: "m" });
    const edge = edgeSummary(edgeId, mapId, childId);

    const ops = integrityCleanupOps([child, grandchild, edge]);
    expect(ops).toHaveLength(1);
    const ids = (ops[0] as any).ids as string[];
    expect(new Set(ids)).toEqual(new Set([childId, grandchildId, edgeId]));
  });

  it("leaves a duplicated root's map alone (preserve-scene, not this file's job)", () => {
    const mapId = "m3";
    const rootA = nodeSummary(nextId(), { mapId, parentId: null, orderKey: "m" });
    const rootB = nodeSummary(nextId(), { mapId, parentId: null, orderKey: "n" });
    expect(integrityCleanupOps([rootA, rootB])).toEqual([]);
  });

  it("leaves a cycle alone (preserve-scene, not this file's job)", () => {
    const mapId = "m4";
    const aId = nextId();
    const bId = nextId();
    const a = nodeSummary(aId, { mapId, parentId: bId, orderKey: "m" });
    const b = nodeSummary(bId, { mapId, parentId: aId, orderKey: "m" });
    expect(integrityCleanupOps([a, b])).toEqual([]);
  });

  /**
   * Counter-test: break the enforcement by only removing the direct orphan,
   * never cascading to its descendants -- a plausible half-fix that leaves a
   * grandchild pointing at an id this same cleanup just deleted.
   */
  it("regression guard: removing only the direct orphan (no cascade) would leave the grandchild dangling", () => {
    const mapId = "m5";
    const rootId = nextId();
    const childId = nextId();
    const grandchildId = nextId();
    const child = nodeSummary(childId, { mapId, parentId: rootId, orderKey: "m" });
    const grandchild = nodeSummary(grandchildId, { mapId, parentId: childId, orderKey: "m" });

    const noCascadeIds = new Set([childId]); // what a half-fix would remove
    const ops = integrityCleanupOps([child, grandchild]);
    const actualIds = new Set((ops[0] as any).ids as string[]);
    expect(actualIds).not.toEqual(noCascadeIds);
    expect(actualIds.has(grandchildId)).toBe(true);
  });
});
