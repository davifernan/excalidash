import { describe, expect, it } from "vitest";
import { arrangeOps, importOps, mindMapLayoutRunCount } from "./mindMapScene";
import type { ElementId, ElementSummary } from "../integrations/excalidraw/types";
import type { ImportedNode } from "./outlineParser";

const summary = (over: Partial<ElementSummary> = {}): ElementSummary => ({
  id: "e1" as ElementId,
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

const importedNode = (text: string, children: readonly ImportedNode[] = []): ImportedNode => ({
  text,
  line: 1,
  children,
});

describe("arrangeOps: the explicit 'Arrange' command, ambient graph in", () => {
  it("patches descendant positions and leaves the root's own position untouched", () => {
    const before = mindMapLayoutRunCount();
    const summaries = [
      node("root", 500, 500),
      // Both children far away, but consistently to the right of root, the
      // same "same coarse direction" the layout itself always produces --
      // Arrange must still fix their exact position.
      node("a", 9999, 100),
      node("b", 9999, 900),
      arrow("e1", "root", "a"),
      arrow("e2", "root", "b"),
    ];

    const ops = arrangeOps(summaries, "root");
    expect(ops).not.toBeNull();
    expect(ops!.some((op) => op.kind === "patch" && op.id === "root")).toBe(false);
    const patchedIds = ops!.filter((op) => op.kind === "patch").map((op) => (op as any).id);
    // Node positions AND the two edges' own geometry -- neither move is a
    // native drag, so nothing reflows the arrows on its own.
    expect(new Set(patchedIds)).toEqual(new Set(["a", "b", "e1", "e2"]));
    expect(mindMapLayoutRunCount()).toBe(before + 1);
  });

  it("recomputes edge geometry so an arranged arrow visually reaches both its endpoints", () => {
    const summaries = [
      node("root", 500, 500),
      node("a", 9999, 100),
      node("b", 9999, 900),
      arrow("e1", "root", "a"),
      arrow("e2", "root", "b"),
    ];

    const ops = arrangeOps(summaries, "root")!;
    const edgeOp = ops.find((op) => op.kind === "patch" && op.id === "e1") as any;
    expect(edgeOp).toBeDefined();
    // Not the placeholder [[0.5,0.5],[0.5,0.5]] convertToExcalidrawElements
    // leaves an arrow at when only `start`/`end` binding shorthand is used
    // -- a real, non-zero span.
    expect(edgeOp.changes.points[1]).not.toEqual([0.5, 0.5]);
    const [dx, dy] = edgeOp.changes.points[1];
    expect(Math.hypot(dx, dy)).toBeGreaterThan(1);
  });

  it("returns null for an unknown root id", () => {
    expect(arrangeOps([node("root", 0, 0)], "does-not-exist")).toBeNull();
  });

  it("returns null for a leaf with no qualifying children -- nothing to arrange", () => {
    expect(arrangeOps([node("solo", 0, 0)], "solo")).toBeNull();
  });

  it("returns null on a cycle rather than a partial layout (NIL-593's own silence-over-guessing rule)", () => {
    const before = mindMapLayoutRunCount();
    const summaries = [
      node("a", 0, 0),
      node("b", 300, 0),
      node("c", 600, 0),
      arrow("e1", "a", "b"),
      arrow("e2", "b", "c"),
      arrow("e3", "c", "a"),
    ];
    expect(arrangeOps(summaries, "a")).toBeNull();
    expect(mindMapLayoutRunCount()).toBe(before); // a declined arrange never runs layout
  });

  it("a flowchart decision point's diverging branches: nothing to arrange, existing board unharmed", () => {
    const summaries = [
      node("hub", 0, 0),
      node("down", 0, 300),
      node("right", 300, 0),
      arrow("e1", "hub", "down"),
      arrow("e2", "hub", "right"),
    ];
    expect(arrangeOps(summaries, "hub")).toBeNull();
  });

  it("moves a bound label along with its container by the same delta", () => {
    const summaries = [
      node("root", 0, 0),
      node("a", 9000, 9000, { boundElements: [{ id: "a-label" as ElementId, type: "text" }] }),
      node("a-label", 9010, 9010, { containerId: "a" as ElementId, type: "text" }),
      arrow("e1", "root", "a"),
    ];
    const ops = arrangeOps(summaries, "root");
    expect(ops).not.toBeNull();
    const labelOp = ops!.find((op) => op.kind === "patch" && op.id === "a-label") as any;
    const nodeOp = ops!.find((op) => op.kind === "patch" && op.id === "a") as any;
    expect(labelOp).toBeDefined();
    // the label kept its original +10/+10 offset from its container
    expect(labelOp.changes.x - nodeOp.changes.x).toBe(10);
    expect(labelOp.changes.y - nodeOp.changes.y).toBe(10);
  });
});

describe("importOps: an outline becomes ordinary elements, never customData.mindMap", () => {
  it("creates one rectangle+label insert per node, one arrow insert per edge, and selects the root", () => {
    const before = mindMapLayoutRunCount();
    const root = importedNode("Project", [importedNode("Design"), importedNode("Build")]);

    const { ops, rootId } = importOps(root, { x: 0, y: 0 });

    const inserts = ops.filter((op) => op.kind === "insert");
    // 3 nodes -> 3 (rectangle, label) inserts; 2 edges -> 2 arrow inserts.
    expect(inserts).toHaveLength(5);
    const insertedElements = inserts.flatMap((op) => (op as any).elements);
    expect(insertedElements).toHaveLength(3 * 2 + 2);

    const arrows = insertedElements.filter((el: any) => el.type === "arrow");
    expect(arrows).toHaveLength(2);

    const selectOp = ops.find((op) => op.kind === "select");
    expect(selectOp).toEqual({ kind: "select", ids: [rootId] });

    expect(mindMapLayoutRunCount()).toBe(before + 1);
  });

  it("gives every created arrow real, non-degenerate geometry -- not the [0,0]/[1,1] placeholder", () => {
    const root = importedNode("Project", [importedNode("Design")]);
    const { ops } = importOps(root, { x: 0, y: 0 });
    const arrows = ops
      .filter((op) => op.kind === "insert")
      .flatMap((op) => (op as any).elements)
      .filter((el: any) => el.type === "arrow");
    expect(arrows).toHaveLength(1);
    const [start, end] = arrows[0].points;
    expect(start).toEqual([0, 0]);
    expect(Math.hypot(end[0], end[1])).toBeGreaterThan(1);
  });

  it("never writes customData.excalidash.mindMap on any created element", () => {
    const root = importedNode("Root", [importedNode("Child")]);
    const { ops } = importOps(root, { x: 0, y: 0 });

    for (const op of ops) {
      if (op.kind !== "insert") continue;
      for (const element of (op as any).elements) {
        const excalidash = element.customData?.excalidash;
        expect(excalidash?.mindMap).toBeUndefined();
        expect(excalidash?.mindMapProjection).toBeUndefined();
      }
    }
  });

  it("gives every node real text via a bound label, not an empty rectangle", () => {
    const root = importedNode("Hello world");
    const { ops } = importOps(root, { x: 0, y: 0 });
    const labels = ops
      .filter((op) => op.kind === "insert")
      .flatMap((op) => (op as any).elements)
      .filter((el: any) => el.type === "text");
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("Hello world");
  });

  it("a single-node outline (no edges) still imports and selects that one node", () => {
    const root = importedNode("Solo");
    const { ops, rootId } = importOps(root, { x: 0, y: 0 });
    const arrows = ops
      .filter((op) => op.kind === "insert")
      .flatMap((op) => (op as any).elements)
      .filter((el: any) => el.type === "arrow");
    expect(arrows).toHaveLength(0);
    expect(ops.find((op) => op.kind === "select")).toEqual({ kind: "select", ids: [rootId] });
  });
});
