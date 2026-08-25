/**
 * What an imported outline node and its edge are made of (NIL-593, Schnitt
 * 2). Not a new element type, and not a mind-map-tagged one either: an
 * imported node is an ordinary rectangle with ordinary bound text, an
 * imported edge is an ordinary bound arrow -- exactly what a hand-drawn box
 * and arrow would be, so `ambientTree/`'s drag-follow (Schnitt 1) picks
 * them up automatically. No `customData.excalidash.mindMap` is ever
 * written; nothing here has heard of a mind map.
 *
 * Replaces the old `mindMapElements.ts`, which stamped every node/edge with
 * a `customData.excalidash.mindMap`/`mindMapProjection` relationship. That
 * relationship layer is gone (see `../integrations/excalidraw/customData.ts`'s
 * own header comment) -- structure now lives entirely in the arrow
 * bindings this file constructs.
 */
import { buildElements } from "../integrations/excalidraw/elements";
import type { BoundElementRef } from "../integrations/excalidraw/types";
import { MIND_MAP_LAYOUT_V1 } from "./layout";

/**
 * Named colour tokens, not scattered hex literals -- same values the old
 * mind-map tool used (Excalidraw's own `COLOR_PALETTE.black`/`gray[3]`),
 * kept for visual continuity even though the underlying element is now
 * indistinguishable from any other rectangle/arrow.
 */
export const IMPORT_COLORS = Object.freeze({
  nodeStroke: "#1e1e1e",
  edgeStroke: "#868e96",
});

export const newImportElementId = (): string => crypto.randomUUID();

export type NodeBox = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * A node rectangle WITH its text already set: an import has real text from
 * the source outline up front, unlike drawing a fresh empty box by hand --
 * there is no "start typing" moment to defer a label to. `label: { text }`
 * on the skeleton is `@excalidraw/excalidraw`'s own supported way to create
 * a bound text element in the SAME `convertToExcalidrawElements` batch
 * (confirmed empirically: the returned rectangle's `boundElements` already
 * names the text element, and the text element's `containerId` already
 * names the rectangle back -- real, two-way binding from construction).
 */
export function createImportNode(
  id: string,
  x: number,
  y: number,
  text: string,
): { readonly rectangle: any; readonly label: any } {
  const [rectangle, label] = buildElements(
    [
      {
        id,
        type: "rectangle",
        x,
        y,
        width: MIND_MAP_LAYOUT_V1.nodeWidth,
        height: MIND_MAP_LAYOUT_V1.nodeHeight,
        backgroundColor: "transparent",
        strokeColor: IMPORT_COLORS.nodeStroke,
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 0,
        roundness: { type: 3 },
        opacity: 100,
        label: { text },
      },
    ] as any,
    { regenerateIds: false },
  ) as any[];

  return { rectangle: { ...rectangle, index: null }, label: { ...label, index: null } };
}

/**
 * The visible edge from a parent node to a child node: a real bound arrow,
 * right-middle of the parent to left-middle of the child (the geometry
 * `start`/`end` binding-by-id resolves to for a fixed-size, left-to-right
 * tidy tree). Both boxes are read fresh from the caller's own layout
 * result -- this only computes the arrow; the caller still owns merging
 * `boundElements` onto the live parent/child.
 */
export function createImportEdge(id: string, parentBox: NodeBox, childBox: NodeBox): any {
  return arrowElementBetween(id, parentBox, childBox);
}

/**
 * Recompute an EXISTING bound arrow's own geometry (x/y/points) after
 * "Arrange" (`mindMapScene.ts`) patches both its endpoints' positions.
 *
 * Excalidraw only reflows a bound arrow's geometry automatically when the
 * moved endpoint is the one Excalidraw itself is actively, natively
 * dragging (measured and documented in
 * `../ambientTree/useAmbientTreeDrag.ts`'s own file comment) -- a plain
 * `scene.apply` position patch is not a native drag, so an arrow between
 * two `Arrange`-repositioned nodes needs this explicit recomputation, the
 * same "internal edge" problem that hook already solves for a live drag.
 * Only the geometry changes; the arrow keeps its own id, so its existing
 * `startBinding`/`endBinding`/`boundElements` references are untouched.
 */
export function arrowGeometryBetween(
  parentBox: NodeBox,
  childBox: NodeBox,
): {
  readonly x: number;
  readonly y: number;
  readonly points: readonly (readonly [number, number])[];
} {
  return computeGeometry(parentBox, childBox);
}

/**
 * Right-middle of the parent to left-middle of the child, in the arrow's
 * own local point space (`[0, 0]` at the arrow's own `x`/`y`).
 *
 * `convertToExcalidrawElements`'s `start`/`end` shorthand (used below in
 * `arrowElementBetween` to get real `startBinding`/`endBinding`) sets ONLY
 * that binding metadata -- confirmed by inspection, not the doc: it leaves
 * `x`/`y`/`points` at whatever placeholder the skeleton passed in
 * (`x: 0, y: 0, points: [[0,0],[1,1]]`, scaled to a 1x1 arrow), because the
 * actual reflow-to-match-the-bound-shapes math lives in Excalidraw's
 * runtime binding code (`bindOrUnbindLinearElement`), not in this batch
 * conversion. An import produced literally invisible, zero-length arrows
 * pinned at the scene origin before this was found and fixed.
 */
const computeGeometry = (
  parentBox: NodeBox,
  childBox: NodeBox,
): {
  readonly x: number;
  readonly y: number;
  readonly points: readonly (readonly [number, number])[];
} => {
  const start = { x: parentBox.x + parentBox.width, y: parentBox.y + parentBox.height / 2 };
  const end = { x: childBox.x, y: childBox.y + childBox.height / 2 };
  return {
    x: start.x,
    y: start.y,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  };
};

const arrowElementBetween = (id: string, parentBox: NodeBox, childBox: NodeBox): any => {
  const [, , arrow] = buildElements(
    [
      {
        id: parentBox.id,
        type: "rectangle",
        x: parentBox.x,
        y: parentBox.y,
        width: parentBox.width,
        height: parentBox.height,
      },
      {
        id: childBox.id,
        type: "rectangle",
        x: childBox.x,
        y: childBox.y,
        width: childBox.width,
        height: childBox.height,
      },
      {
        id,
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [1, 1],
        ],
        strokeColor: IMPORT_COLORS.edgeStroke,
        strokeWidth: 1.5,
        roughness: 0,
        start: { id: parentBox.id },
        end: { id: childBox.id },
      },
    ] as any,
    { regenerateIds: false },
  ) as any[];

  const geometry = computeGeometry(parentBox, childBox);
  return {
    ...arrow,
    index: null,
    x: geometry.x,
    y: geometry.y,
    points: geometry.points,
    width: Math.abs(geometry.points[1][0]),
    height: Math.abs(geometry.points[1][1]),
  };
};

/**
 * The `boundElements` a shape should carry after gaining an edge: whatever
 * it already had (its own bound label from `createImportNode`, anything
 * foreign) plus the new edge ref, deduplicated by id.
 */
export function mergeEdgeBinding(
  current: readonly BoundElementRef[] | null,
  add: readonly BoundElementRef[],
): readonly BoundElementRef[] {
  const kept = current ?? [];
  const keptIds = new Set(kept.map((ref) => ref.id));
  return [...kept, ...add.filter((ref) => !keptIds.has(ref.id))];
}
