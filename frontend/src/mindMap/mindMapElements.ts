/**
 * What a mind-map node and its edge are made of.
 *
 * Not a new element type (NIL-569's binding decision): a node is an ordinary
 * rectangle with ordinary bound text, an edge is an ordinary bound arrow. The
 * one thing that makes them a mind map is `customData.excalidash.mindMap` /
 * `mindMapProjection`, read and written through
 * `../integrations/excalidraw/customData.ts`.
 *
 * ## Native binding (NIL-575)
 *
 * Edges used to be geometry this package computed and owned end to end,
 * deliberately not Excalidraw's own `startBinding`/`endBinding`, because a
 * real two-way binding needs the *shape's* `boundElements` kept in sync too,
 * and that field was not part of `ElementSummary`/`ElementPatch`. NIL-575
 * grew that capability (see `ElementSummary.boundElements` and
 * `ElementPatch.boundElements` in `../integrations/excalidraw/types.ts`), so
 * edges are now real bound arrows.
 *
 * The arrow's own `startBinding`/`endBinding` (with the gap/focus geometry
 * Excalidraw computes for a bound arrow) come from the package's own
 * skeleton conversion: `createMindMapEdge` describes the parent and child
 * boxes in the *same* `convertToExcalidrawElements` batch as the arrow,
 * which is enough for the package to compute a correctly bound arrow even
 * though the parent/child themselves already exist in the live scene and
 * are not re-inserted -- only the arrow is. What that batch does NOT know
 * about is the *shape's* current `boundElements` (its own bound label, any
 * other edge it already carries), so this file never trusts a batch-echoed
 * shape's `boundElements` -- callers merge the new edge ref into the
 * shape's real, live `boundElements` themselves (`mergeEdgeBinding` below),
 * read from `ElementSummary` immediately before the merge.
 */
import { buildElements } from "../integrations/excalidraw/elements";
import { withExcalidashData, type MindMapRecord } from "../integrations/excalidraw/customData";
import type { BoundElementRef } from "../integrations/excalidraw/types";
import { MIND_MAP_LAYOUT_V1 } from "./layout";

/**
 * Named colour tokens, not scattered hex literals.
 *
 * Excalidraw's own `COLOR_PALETTE`/`DEFAULT_ELEMENT_PROPS` (which carry these
 * exact values -- `black` and open-color `gray[6]`) are not part of the
 * package's public runtime export surface (`package.json`'s `exports` map
 * only exposes `.d.ts` types for a subpath, no JS): confirmed by reading the
 * built `dist/dev/index.js` export list, which stops at `CaptureUpdateAction`
 * /`FONT_FAMILY`/`ROUNDNESS` and does not include either. Defined once, here,
 * so every mind-map element still reads a name -- `MIND_MAP_COLORS.nodeStroke`
 * -- rather than a bare `"#1e1e1e"` repeated at each call site.
 */
export const MIND_MAP_COLORS = Object.freeze({
  /** Same value as Excalidraw's own `COLOR_PALETTE.black`. */
  nodeStroke: "#1e1e1e",
  /** Same value as Excalidraw's own `COLOR_PALETTE.gray[3]` (open-color gray-6). */
  edgeStroke: "#868e96",
});

export const newMindMapElementId = (): string => crypto.randomUUID();
export const newMindMapId = (): string => crypto.randomUUID();

/**
 * A node rectangle, unlabelled.
 *
 * Deliberately without a label, the same reason `createStickyNote` has none:
 * Excalidraw creates the bound text itself the moment typing starts, and an
 * empty one created ahead of time would be discarded by the next restore.
 */
export function createMindMapNode(id: string, x: number, y: number, relation: MindMapRecord): any {
  const [rectangle] = buildElements(
    [
      {
        id,
        type: "rectangle",
        x,
        y,
        width: MIND_MAP_LAYOUT_V1.nodeWidth,
        height: MIND_MAP_LAYOUT_V1.nodeHeight,
        backgroundColor: "transparent",
        strokeColor: MIND_MAP_COLORS.nodeStroke,
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 0,
        roundness: { type: 3 },
        opacity: 100,
      },
    ] as any,
    { regenerateIds: false },
  ) as any[];

  return {
    ...rectangle,
    index: null,
    customData: withExcalidashData(rectangle, { mindMap: relation }),
  };
}

export type NodeBox = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The visible edge from a parent node to a child node: a real bound arrow,
 * right-middle of the parent to left-middle of the child (the geometry
 * `start`/`end` binding-by-id resolves to for a fixed-size, left-to-right
 * tidy tree). Both boxes are read fresh from the caller's own layout
 * result -- this only computes the arrow; the caller still owns patching
 * `boundElements` onto the live parent/child (`mergeEdgeBinding` below).
 */
export function createMindMapEdge(
  id: string,
  mapId: string,
  parentBox: NodeBox,
  childBox: NodeBox,
): any {
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
        strokeColor: MIND_MAP_COLORS.edgeStroke,
        strokeWidth: 1.5,
        roughness: 0,
        start: { id: parentBox.id },
        end: { id: childBox.id },
      },
    ] as any,
    { regenerateIds: false },
  ) as any[];

  return {
    ...arrow,
    index: null,
    customData: withExcalidashData(arrow, { mindMapProjection: { mapId, childId: childBox.id } }),
  };
}

/**
 * The `boundElements` a shape should carry after its mind-map edges change:
 * whatever it already had (its own bound label, anything foreign), minus
 * any id in `remove` (edges being deleted or replaced this round), plus
 * `add` (the edge(s) this round gives it). `remove`/`add` only ever name
 * arrows -- a shape's bound *label* is never in either set, so it always
 * survives untouched.
 */
export function mergeEdgeBinding(
  current: readonly BoundElementRef[] | null,
  remove: ReadonlySet<string>,
  add: readonly BoundElementRef[],
): readonly BoundElementRef[] {
  const kept = (current ?? []).filter((ref) => !remove.has(ref.id));
  const keptIds = new Set(kept.map((ref) => ref.id));
  return [...kept, ...add.filter((ref) => !keptIds.has(ref.id))];
}
