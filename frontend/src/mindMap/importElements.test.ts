import { describe, expect, it } from "vitest";
import { arrowGeometryBetween, createImportEdge, createImportNode } from "./importElements";

const box = (id: string, x: number, y: number, width = 200, height = 80) => ({
  id,
  x,
  y,
  width,
  height,
});

describe("arrowGeometryBetween: right-middle of the parent to left-middle of the child", () => {
  it("is never the [0,0]/[1,1] placeholder convertToExcalidrawElements' start/end shorthand leaves behind", () => {
    const geometry = arrowGeometryBetween(box("parent", 0, 0), box("child", 400, 0));
    expect(geometry.points[0]).toEqual([0, 0]);
    expect(geometry.points[1]).not.toEqual([1, 1]);
  });

  it("spans exactly the gap between the two boxes for a same-row layout", () => {
    const parent = box("parent", 0, 0);
    const child = box("child", 400, 0);
    const geometry = arrowGeometryBetween(parent, child);
    expect(geometry.x).toBe(parent.x + parent.width);
    expect(geometry.y).toBe(parent.y + parent.height / 2);
    expect(geometry.points[1]).toEqual([child.x - (parent.x + parent.width), 0]);
  });

  it("accounts for vertical offset between rows", () => {
    const parent = box("parent", 0, 0);
    const child = box("child", 400, 200);
    const geometry = arrowGeometryBetween(parent, child);
    const [, [dx, dy]] = geometry.points;
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeCloseTo(child.y + child.height / 2 - (parent.y + parent.height / 2));
  });
});

describe("createImportEdge: the actual arrow element an import inserts", () => {
  it("carries the same real geometry arrowGeometryBetween computes, plus binding metadata", () => {
    const parent = box("parent", 0, 0);
    const child = box("child", 400, 0);
    const arrow = createImportEdge("edge-1", parent, child);
    const geometry = arrowGeometryBetween(parent, child);
    expect(arrow.x).toBe(geometry.x);
    expect(arrow.y).toBe(geometry.y);
    expect(arrow.points).toEqual(geometry.points);
    expect(arrow.startBinding?.elementId).toBe("parent");
    expect(arrow.endBinding?.elementId).toBe("child");
  });
});

describe("createImportNode: a real rectangle with a real bound label", () => {
  it("gives the label real text and a two-way binding to the rectangle", () => {
    const { rectangle, label } = createImportNode("node-1", 0, 0, "Hello");
    expect(label.text).toBe("Hello");
    expect(label.containerId).toBe("node-1");
    expect(rectangle.boundElements?.some((ref: any) => ref.id === label.id)).toBe(true);
  });
});
