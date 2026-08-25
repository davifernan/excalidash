/**
 * What a mind-map node and its edge are made of.
 *
 * Not a new element type (NIL-569's binding decision): a node is an ordinary
 * rectangle with ordinary bound text, an edge is an ordinary arrow. The one
 * thing that makes them a mind map is `customData.excalidash.mindMap` /
 * `mindMapProjection`, read and written through
 * `../integrations/excalidraw/customData.ts`.
 *
 * ## Why the edge is geometric, not `startBinding`/`endBinding`
 *
 * Excalidraw's own two-way arrow binding needs the *shape's* `boundElements`
 * kept in sync with the arrow's `startBinding`/`endBinding` -- that field is
 * not part of `ElementSummary` or `ElementPatch` today (`types.ts`'s own file
 * comment: `SceneDocument` is "opaque and lossless... product code never
 * reads fields off it"). Setting only the arrow's half would leave a
 * one-sided binding: on structural changes this package already deletes and
 * recreates every projection edge from the map's post-layout coordinates
 * (see `mindMapScene.ts`), and on a delete this package already runs its own
 * customData-driven cascade (`mindMapIntegrity.ts`) rather than relying on
 * Excalidraw's native bound-arrow cleanup -- so a real two-way binding would
 * buy native drag-follow during a live pointer-drag and nothing else, at the
 * cost of extending the shared `SceneCapability` contract mid-package. That
 * trade is the integration session's call, not this package's -- tracked as
 * NIL-575, not snuck in here. Every edge this package draws is instead
 * ordinary geometry the map's own code owns end to end: recomputed by
 * `mindMapScene.ts` whenever the map is laid out, and rigidly translated by
 * `useMindMapDrag.ts` on every subtree drag.
 */
import { buildElements } from "../integrations/excalidraw/elements";
import { withExcalidashData, type MindMapRecord } from "../integrations/excalidraw/customData";
import { MIND_MAP_LAYOUT_V1 } from "./layout";

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
        strokeColor: "#1e1e1e",
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
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The visible edge from a parent node box to a child node box: right-middle
 * of the parent to left-middle of the child, the natural anchor pair for a
 * fixed-size, left-to-right tidy tree. Both boxes are read fresh from the
 * caller's own layout result, never from a live Excalidraw binding.
 */
export function createMindMapEdge(
  id: string,
  mapId: string,
  childId: string,
  parentBox: NodeBox,
  childBox: NodeBox,
): any {
  const start = { x: parentBox.x + parentBox.width, y: parentBox.y + parentBox.height / 2 };
  const end = { x: childBox.x, y: childBox.y + childBox.height / 2 };

  const [arrow] = buildElements(
    [
      {
        id,
        type: "arrow",
        x: start.x,
        y: start.y,
        points: [
          [0, 0],
          [end.x - start.x, end.y - start.y],
        ],
        strokeColor: "#868e96",
        strokeWidth: 1.5,
        roughness: 0,
      },
    ] as any,
    { regenerateIds: false },
  ) as any[];

  return {
    ...arrow,
    index: null,
    customData: withExcalidashData(arrow, { mindMapProjection: { mapId, childId } }),
  };
}
