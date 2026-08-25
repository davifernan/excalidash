/**
 * Turning a live scene into a normalized map, and a structural intent
 * (add child, add sibling, arrange) into the one batch of `SceneOp`s that
 * materializes it.
 *
 * This is the one file that is allowed to know both `model.ts`/`layout.ts`
 * (pure, DOM-free) and `ElementSummary`/`SceneOp` (the live adapter). Keeping
 * that seam in one place is what makes the purity claim in `layout.ts`
 * checkable: nothing here passes a viewport, a selection or a clock into the
 * pure core, and every pure call's inputs are visible in one function.
 */
import type { ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { readMindMap, readMindMapProjection } from "../integrations/excalidraw/customData";
import {
  compareStableStrings,
  normalizeMindMap,
  subtreeElementIds,
  type MindMapNodeInput,
  type NormalizedMindMap,
} from "./model";
import { layoutMindMap, MIND_MAP_LAYOUT_V1, type MindMapLayoutPosition } from "./layout";
import { createMindMapEdge, createMindMapNode, newMindMapElementId, type NodeBox } from "./mindMapElements";
import { orderKeyAfter } from "./mindMapOrder";

export type MindMapNode = { readonly summary: ElementSummary; readonly relation: NonNullable<ReturnType<typeof readMindMap>> };

/** Every mind-map node currently on the canvas, live rectangle attached. */
export function readMindMapNodes(summaries: readonly ElementSummary[]): readonly MindMapNode[] {
  const nodes: MindMapNode[] = [];
  for (const summary of summaries) {
    if (summary.isDeleted) continue;
    const relation = readMindMap(summary);
    if (relation) nodes.push({ summary, relation });
  }
  return nodes;
}

/** Every projection arrow currently on the canvas, grouped by the map it belongs to. */
export function readMindMapEdges(
  summaries: readonly ElementSummary[],
): ReadonlyMap<string, readonly ElementSummary[]> {
  const byMap = new Map<string, ElementSummary[]>();
  for (const summary of summaries) {
    if (summary.isDeleted) continue;
    const projection = readMindMapProjection(summary);
    if (!projection) continue;
    const list = byMap.get(projection.mapId) ?? [];
    list.push(summary);
    byMap.set(projection.mapId, list);
  }
  return byMap;
}

/**
 * How many times this module has run the pure layout core.
 *
 * Test-only counter, read through `window.__EXCALIDASH_TEST__` in
 * `Editor.tsx` (`getMindMapLayoutRunCount`). This is NIL-570's own required
 * evidence -- "a layout run on the receiving client" is a negative to prove,
 * not a position to eyeball, since a deterministic layout run over an
 * already-correct tree reproduces the exact same coordinates it started
 * with. A collaboration spec asserts this counter is unchanged on the
 * receiving client after the sending client's structural action arrives,
 * which a coordinate comparison alone cannot tell apart from "ran again and
 * got the same answer".
 */
let layoutRunCount = 0;
export const mindMapLayoutRunCount = (): number => layoutRunCount;

export function normalizeLiveMap(
  summaries: readonly ElementSummary[],
  mapId: string,
): ReturnType<typeof normalizeMindMap> {
  const inputs: MindMapNodeInput[] = readMindMapNodes(summaries).map((node) => ({
    elementId: node.summary.id,
    relation: node.relation,
  }));
  return normalizeMindMap(inputs, mapId);
}

/**
 * One layout run, materialized as ops: patch every node whose coordinates
 * changed, and replace every projection edge for this map with a fresh one
 * built from the new coordinates (cheaper and simpler than patching arrow
 * geometry in place, and correct regardless of how many endpoints moved --
 * see `mindMapElements.ts`'s file comment for why edges are not patched).
 *
 * Never called from `onChange`, a pointer move, a remote update, save,
 * restore or reconnect -- only from an explicit structural action or the
 * "Arrange mind map" command, both of which call this directly and nothing
 * else.
 */
export function layoutOps(
  map: NormalizedMindMap,
  positionsByElementId: ReadonlyMap<string, MindMapLayoutPosition>,
  liveById: ReadonlyMap<string, ElementSummary>,
  existingEdges: readonly ElementSummary[],
  allSummaries: readonly ElementSummary[] = [],
): SceneOp[] {
  const ops: SceneOp[] = [];
  const boxesById = new Map<string, NodeBox>();
  const labelByContainerId = new Map<string, ElementSummary>();
  for (const element of allSummaries) {
    if (element.containerId) labelByContainerId.set(element.containerId, element);
  }

  for (const node of map.nodes) {
    const position = positionsByElementId.get(node.elementId);
    if (!position) continue;
    // Every node in the map gets a box, whether or not it already exists on
    // the canvas: a brand-new node (added in the same batch, see
    // `addNodeOps`) is inserted with this position directly, so it needs a
    // box for the edge-drawing pass below without needing a patch here.
    boxesById.set(node.elementId, {
      x: position.x,
      y: position.y,
      width: MIND_MAP_LAYOUT_V1.nodeWidth,
      height: MIND_MAP_LAYOUT_V1.nodeHeight,
    });
    const live = liveById.get(node.elementId);
    if (live && (live.x !== position.x || live.y !== position.y)) {
      const dx = position.x - live.x;
      const dy = position.y - live.y;
      ops.push({ kind: "patch", id: live.id as never, changes: { x: position.x, y: position.y } });
      // The rectangle's own bound label is a separate element with its own
      // x/y; Excalidraw only keeps it glued to its container through the
      // package's own move machinery, not through a raw `patch`. Translating
      // it by the same delta preserves whatever offset Excalidraw gave it
      // (centering, wrapping) without this code needing to know what that
      // offset is. Caught by a real browser run (mind-map.spec.ts's drag
      // test's screenshots, not its assertions -- the label carries no
      // customData for a jsdom test to check position on).
      const label = labelByContainerId.get(node.elementId);
      if (label) {
        ops.push({ kind: "patch", id: label.id as never, changes: { x: label.x + dx, y: label.y + dy } });
      }
    }
  }

  const staleEdgeIds = existingEdges.map((edge) => edge.id);
  if (staleEdgeIds.length > 0) ops.push({ kind: "remove", ids: staleEdgeIds as never });

  for (const node of map.nodes) {
    if (node.parentId === null) continue;
    const parentBox = boxesById.get(node.parentId);
    const childBox = boxesById.get(node.elementId);
    if (!parentBox || !childBox) continue;
    ops.push({
      kind: "insert",
      elements: [createMindMapEdge(newMindMapElementId(), map.mapId, node.elementId, parentBox, childBox)],
    });
  }

  return ops;
}

/** Positions for every node in a normalized map, root anchored at its own current top-left. */
export function computeLayoutPositions(
  map: NormalizedMindMap,
  liveById: ReadonlyMap<string, ElementSummary>,
): ReadonlyMap<string, MindMapLayoutPosition> {
  const root = liveById.get(map.rootId);
  const anchor = root ? { x: root.x, y: root.y } : { x: 0, y: 0 };
  layoutRunCount += 1;
  const positions = layoutMindMap(map, MIND_MAP_LAYOUT_V1, anchor);
  return new Map(positions.map((position) => [position.elementId, position]));
}

/**
 * A brand-new root at a canvas point: one map, one node, no edges yet.
 * `orderKey` is the map's fixed first key -- there are no siblings to order
 * against.
 */
export function createRootOps(mapId: string, id: string, x: number, y: number): SceneOp[] {
  const node = createMindMapNode(
    id,
    x - MIND_MAP_LAYOUT_V1.nodeWidth / 2,
    y - MIND_MAP_LAYOUT_V1.nodeHeight / 2,
    { mapId, parentId: null, orderKey: orderKeyAfter([]) },
  );
  return [
    { kind: "insert", elements: [node] },
    { kind: "select", ids: [id as never] },
  ];
}

/**
 * Add a child under `parentId` (Tab), or a sibling after `afterId` under its
 * same parent (Enter) -- both append-only (v1 has no drag-to-reorder), both
 * followed by exactly one layout run over the whole map so the new node
 * lands in its deterministic tidy-tree position rather than wherever a
 * placeholder offset would have put it.
 *
 * Enter on the root becomes a child add, not a sibling add: a map has
 * exactly one root (`model.ts`'s own invariant), so "sibling of the root"
 * has no answer to give. This is one of the cases NIL-570 asks to be
 * decided explicitly rather than left as "should work" -- decided here, in
 * one place, so `useMindMapKeys.ts` never has to special-case it again.
 */
export function addNodeOps(
  summaries: readonly ElementSummary[],
  kind: "child" | "sibling",
  anchorId: string,
): { ops: SceneOp[]; newNodeId: string } | null {
  const nodes = readMindMapNodes(summaries);
  const anchor = nodes.find((node) => node.summary.id === anchorId);
  if (!anchor) return null;

  const mapId = anchor.relation.mapId;
  const normalized = normalizeLiveMap(summaries, mapId);
  if (!normalized.ok) return null;

  const asSibling = kind === "sibling" && anchor.relation.parentId !== null;
  const parentId = asSibling ? (anchor.relation.parentId as string) : anchorId;

  const siblingKeys = nodes
    .filter((node) => node.relation.parentId === parentId)
    .map((node) => node.relation.orderKey);
  const newId = newMindMapElementId();
  const newNode = createMindMapNode(newId, 0, 0, {
    mapId,
    parentId,
    orderKey: orderKeyAfter(siblingKeys),
  });

  const liveById = new Map(nodes.map((node) => [node.summary.id, node.summary]));
  const withNewNode = normalizeLiveMap(
    [...summaries, { ...newNode, isDeleted: false } as unknown as ElementSummary],
    mapId,
  );
  if (!withNewNode.ok) return null;

  const positions = computeLayoutPositions(withNewNode.value, liveById);
  const newPosition = positions.get(newId);
  if (!newPosition) return null;

  const placedNode = { ...newNode, x: newPosition.x, y: newPosition.y };
  const edgesForMap = readMindMapEdges(summaries).get(mapId) ?? [];

  const ops: SceneOp[] = [
    { kind: "insert", elements: [placedNode] },
    ...layoutOps(withNewNode.value, positions, liveById, edgesForMap, summaries),
    { kind: "select", ids: [newId as never] },
  ];

  return { ops, newNodeId: newId };
}

/** The explicit "Arrange mind map" command: recompute the whole map's layout, nothing else. */
export function arrangeOps(summaries: readonly ElementSummary[], mapId: string): SceneOp[] | null {
  const normalized = normalizeLiveMap(summaries, mapId);
  if (!normalized.ok) return null;
  const liveById = new Map(readMindMapNodes(summaries).map((node) => [node.summary.id, node.summary]));
  const positions = computeLayoutPositions(normalized.value, liveById);
  const edgesForMap = readMindMapEdges(summaries).get(mapId) ?? [];
  return layoutOps(normalized.value, positions, liveById, edgesForMap, summaries);
}

/** The map id of a mind-map node, or null. */
export function mapIdOf(summary: ElementSummary | null | undefined): string | null {
  if (!summary) return null;
  return readMindMap(summary)?.mapId ?? null;
}

export { subtreeElementIds, compareStableStrings };
