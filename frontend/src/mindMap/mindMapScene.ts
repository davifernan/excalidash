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
import type { BoundElementRef, ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import {
  readMindMap,
  readMindMapProjection,
  withExcalidashData,
} from "../integrations/excalidraw/customData";
import {
  compareStableStrings,
  normalizeMindMap,
  subtreeElementIds,
  type MindMapNodeInput,
  type NormalizedMindMap,
} from "./model";
import { layoutMindMap, MIND_MAP_LAYOUT_V1, type MindMapLayoutPosition } from "./layout";
import {
  createMindMapEdge,
  createMindMapNode,
  MIND_MAP_COLORS,
  mergeEdgeBinding,
  newMindMapElementId,
  type NodeBox,
} from "./mindMapElements";
import { orderKeyAfter } from "./mindMapOrder";

export type MindMapNode = {
  readonly summary: ElementSummary;
  readonly relation: NonNullable<ReturnType<typeof readMindMap>>;
};

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
 * geometry in place, and correct regardless of how many endpoints moved).
 * Each fresh edge is a real bound arrow (NIL-575): its own `startBinding`/
 * `endBinding` come from `createMindMapEdge`, and this function patches the
 * *shape's* `boundElements` on both endpoints to match -- native binding is
 * two-way by construction, or it is worse than the geometric edges it
 * replaced (see `mindMapElements.ts`'s file comment).
 *
 * A brand-new node (inserted earlier in the same ops batch by the caller,
 * see `addNodeOps`) has no entry in `liveById` yet; its own `boundElements`
 * patch still lands correctly because `SceneCapability.apply` processes this
 * function's ops in order, after that earlier insert, within the same call.
 *
 * Never called from `onChange`, a pointer move, a remote update, save,
 * restore or reconnect -- only from an explicit structural action or the
 * "Arrange mind map" command, both of which call this directly and nothing
 * else.
 *
 * `pinnedIds` (NIL-571 v2) is the one place a layout run can leave a node's
 * hand-set position untouched: `layoutMindMap` itself still computes a
 * position for every node in the tree, bit-identical for the same tree
 * every time -- the core stays exactly as pure as it was in v1. A pinned
 * node's box for the edge-drawing pass below simply uses its current live
 * position instead of the computed one, and gets no patch (no move, no
 * label move). Everything downstream of that (which edges get redrawn)
 * already reacts correctly to boxes, whichever position produced them.
 */
export function layoutOps(
  map: NormalizedMindMap,
  positionsByElementId: ReadonlyMap<string, MindMapLayoutPosition>,
  liveById: ReadonlyMap<string, ElementSummary>,
  existingEdges: readonly ElementSummary[],
  allSummaries: readonly ElementSummary[] = [],
  pinnedIds: ReadonlySet<string> = new Set(),
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
    const live = liveById.get(node.elementId);
    const pinned = pinnedIds.has(node.elementId) && live;
    // Every node in the map gets a box, whether or not it already exists on
    // the canvas: a brand-new node (added in the same batch, see
    // `addNodeOps`) is inserted with this position directly, so it needs a
    // box for the edge-drawing pass below without needing a patch here. A
    // pinned node keeps its current live box instead of the computed one.
    boxesById.set(node.elementId, {
      id: node.elementId,
      x: pinned ? live.x : position.x,
      y: pinned ? live.y : position.y,
      width: MIND_MAP_LAYOUT_V1.nodeWidth,
      height: MIND_MAP_LAYOUT_V1.nodeHeight,
    });
    if (pinned) continue; // hand-set position: no move, no patch.
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
        ops.push({
          kind: "patch",
          id: label.id as never,
          changes: { x: label.x + dx, y: label.y + dy },
        });
      }
    }
  }

  const staleEdgeIds = new Set(existingEdges.map((edge) => edge.id));
  if (staleEdgeIds.size > 0) ops.push({ kind: "remove", ids: [...staleEdgeIds] as never });

  const newEdgeRefsByNode = new Map<string, BoundElementRef[]>();
  const addRef = (nodeId: string, ref: BoundElementRef) => {
    const list = newEdgeRefsByNode.get(nodeId) ?? [];
    list.push(ref);
    newEdgeRefsByNode.set(nodeId, list);
  };

  for (const node of map.nodes) {
    if (node.parentId === null) continue;
    const parentBox = boxesById.get(node.parentId);
    const childBox = boxesById.get(node.elementId);
    if (!parentBox || !childBox) continue;
    const edgeId = newMindMapElementId();
    ops.push({
      kind: "insert",
      elements: [createMindMapEdge(edgeId, map.mapId, parentBox, childBox)],
    });
    const ref: BoundElementRef = { id: edgeId as never, type: "arrow" };
    addRef(node.parentId, ref);
    addRef(node.elementId, ref);
  }

  for (const [nodeId, refs] of newEdgeRefsByNode) {
    const live = liveById.get(nodeId);
    ops.push({
      kind: "patch",
      id: nodeId as never,
      changes: { boundElements: mergeEdgeBinding(live?.boundElements ?? null, staleEdgeIds, refs) },
    });
  }

  return ops;
}

/** Every node id in `summaries` whose hand-set position an "Arrange mind map" run must not discard. */
export function pinnedNodeIds(summaries: readonly ElementSummary[]): ReadonlySet<string> {
  return new Set(
    readMindMapNodes(summaries)
      .filter((node) => node.relation.pinned === true)
      .map((node) => node.summary.id),
  );
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
    ...layoutOps(
      withNewNode.value,
      positions,
      liveById,
      edgesForMap,
      summaries,
      pinnedNodeIds(summaries),
    ),
    { kind: "select", ids: [newId as never] },
  ];

  return { ops, newNodeId: newId };
}

/**
 * The rectangle, among every OTHER live mind-map node in the same map, whose
 * box contains `point` -- excluding `excludeIds` (the dragged node itself
 * and its own subtree, which `useMindMapReparent.ts` always excludes so a
 * node can never become its own descendant's child by geometry alone).
 * Topmost (last in paint order) first, the same rule `frameAt` in
 * `stickyPlacement.ts` uses for the same reason: nodes can visually overlap
 * mid-drag, and the one on top is the one a person looking at the screen
 * means to drop onto.
 *
 * Pure geometry, no capability reads -- callable both from the live
 * drop-target preview (every frame, while the pointer is still moving) and
 * from the final drop decision (once, against the settled position), so
 * both agree on exactly the same rule.
 */
export function dropTargetFor(
  summaries: readonly ElementSummary[],
  mapId: string,
  excludeIds: ReadonlySet<string>,
  point: { readonly x: number; readonly y: number },
): string | null {
  const nodes = readMindMapNodes(summaries).filter(
    (node) => node.relation.mapId === mapId && !excludeIds.has(node.summary.id),
  );
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { summary } = nodes[i];
    if (
      point.x >= summary.x &&
      point.x <= summary.x + summary.width &&
      point.y >= summary.y &&
      point.y <= summary.y + summary.height
    ) {
      return summary.id;
    }
  }
  return null;
}

/**
 * Reparent `nodeId` under `newParentId` -- an explicit drag-and-drop
 * command (NIL-571), not a position edit: it changes `parentId` and
 * `orderKey` (appended after `newParentId`'s current last child, v2 has no
 * drag-to-reorder-siblings yet), then runs exactly one layout pass over the
 * whole map, the same as `addNodeOps` does for a brand-new node -- the
 * reparented node lands in its new deterministic position, not wherever the
 * pointer happened to release it.
 *
 * Returns `null` for every case NIL-571 asks to reject without losing the
 * node: a cycle (reparenting into one's own descendant), a cross-map
 * target, or a target that does not exist. The caller's job on `null` is to
 * leave the node exactly where it was before the drag -- this function
 * never guesses a fallback placement.
 *
 * Returns `{ ops: [] }` (a genuine no-op, not a rejection) when
 * `newParentId` is already `nodeId`'s current parent: dropping a node back
 * onto the branch it already belongs to changes nothing structurally, and
 * NIL-570's own "layout never runs from a drag" rule means this must not
 * trigger one either.
 */
export function reparentOps(
  summaries: readonly ElementSummary[],
  nodeId: string,
  newParentId: string,
): { ops: SceneOp[] } | null {
  const nodes = readMindMapNodes(summaries);
  const node = nodes.find((n) => n.summary.id === nodeId);
  const newParent = nodes.find((n) => n.summary.id === newParentId);
  if (!node || !newParent) return null;
  if (node.relation.mapId !== newParent.relation.mapId) return null; // cross-map
  if (node.relation.parentId === newParentId) return { ops: [] }; // already there

  const mapId = node.relation.mapId;
  const siblingKeys = nodes
    .filter((n) => n.relation.parentId === newParentId)
    .map((n) => n.relation.orderKey);
  const newOrderKey = orderKeyAfter(siblingKeys);

  const reparented: MindMapNodeInput[] = nodes.map((n) =>
    n.summary.id === nodeId
      ? {
          elementId: n.summary.id,
          relation: { ...n.relation, parentId: newParentId, orderKey: newOrderKey },
        }
      : { elementId: n.summary.id, relation: n.relation },
  );
  const normalized = normalizeMindMap(reparented, mapId);
  if (!normalized.ok) return null; // cycle (reparenting into one's own descendant)

  const liveById = new Map(nodes.map((n) => [n.summary.id, n.summary]));
  const positions = computeLayoutPositions(normalized.value, liveById);
  const edgesForMap = readMindMapEdges(summaries).get(mapId) ?? [];

  const liveNode = liveById.get(nodeId as never)!;
  const ops: SceneOp[] = [
    {
      kind: "patch",
      id: nodeId as never,
      changes: {
        customData: withExcalidashData(liveNode, {
          mindMap: { mapId, parentId: newParentId, orderKey: newOrderKey },
        }),
      },
    },
    ...layoutOps(
      normalized.value,
      positions,
      liveById,
      edgesForMap,
      summaries,
      pinnedNodeIds(summaries),
    ),
  ];

  return { ops };
}

/**
 * The explicit "Arrange mind map" command: recompute the whole map's
 * layout, nothing else -- except a pinned node's own position, which this
 * command exists specifically not to discard (NIL-571 v2; this is the
 * epic's own "point where it breaks" in v1).
 */
export function arrangeOps(summaries: readonly ElementSummary[], mapId: string): SceneOp[] | null {
  const normalized = normalizeLiveMap(summaries, mapId);
  if (!normalized.ok) return null;
  const liveById = new Map(
    readMindMapNodes(summaries).map((node) => [node.summary.id, node.summary]),
  );
  const positions = computeLayoutPositions(normalized.value, liveById);
  const edgesForMap = readMindMapEdges(summaries).get(mapId) ?? [];
  return layoutOps(
    normalized.value,
    positions,
    liveById,
    edgesForMap,
    summaries,
    pinnedNodeIds(summaries),
  );
}

/**
 * Toggle `nodeId`'s pinned flag -- no layout run, ever (NIL-570's own
 * "layout never runs on its own" promise): pinning keeps a node exactly
 * where it already is, and unpinning just marks its position free for the
 * *next* explicit arrange to recompute, not an immediate one. The stroke
 * colour flips with it so pin state is visible on the node itself, not
 * invisible metadata (`mindMapElements.ts`'s `MIND_MAP_COLORS.pinnedStroke`).
 */
export function togglePinOps(
  summaries: readonly ElementSummary[],
  nodeId: string,
): SceneOp[] | null {
  const node = readMindMapNodes(summaries).find((n) => n.summary.id === nodeId);
  if (!node) return null;

  const pinned = !(node.relation.pinned === true);
  return [
    {
      kind: "patch",
      id: nodeId as never,
      changes: {
        strokeColor: pinned ? MIND_MAP_COLORS.pinnedStroke : MIND_MAP_COLORS.nodeStroke,
        customData: withExcalidashData(node.summary, {
          mindMap: { ...node.relation, ...(pinned ? { pinned: true } : { pinned: undefined }) },
        }),
      },
    },
  ];
}

/** Every node id in `summaries` currently collapsed. */
export function collapsedNodeIds(summaries: readonly ElementSummary[]): ReadonlySet<string> {
  return new Set(
    readMindMapNodes(summaries)
      .filter((node) => node.relation.collapsed === true)
      .map((node) => node.summary.id),
  );
}

/**
 * Every element id `nodeId`'s own collapse should hide: its descendant
 * nodes, their bound labels, and every edge whose child endpoint is one of
 * those descendants -- but never `nodeId` itself, nor the one edge coming
 * *into* `nodeId` from its own parent, so a collapsed branch still reads as
 * "there is more here", not as a leaf with nothing behind it. `null` for an
 * unknown node or a genuine leaf (nothing to collapse).
 *
 * Deliberately never touches any element's own data -- this is a read,
 * consulted only by `MindMapCollapseOverlay.tsx` to decide what to mask on
 * screen. A nested collapse (a descendant that is independently collapsed
 * too) is not special-cased here: while an ancestor hides it, its own flag
 * simply has nothing to draw; the moment the ancestor is no longer
 * collapsed, this same function reads that descendant's still-intact flag
 * and masks its own children again, unprompted.
 */
export function collapsedHiddenIds(
  summaries: readonly ElementSummary[],
  nodeId: string,
): { readonly ids: ReadonlySet<string>; readonly nodeCount: number } | null {
  const node = readMindMapNodes(summaries).find((n) => n.summary.id === nodeId);
  if (!node) return null;

  const normalized = normalizeLiveMap(summaries, node.relation.mapId);
  if (!normalized.ok) return null;
  const descendantNodeIds = subtreeElementIds(normalized.value, nodeId).filter(
    (id) => id !== nodeId,
  );
  if (descendantNodeIds.length === 0) return null; // a leaf: nothing to collapse

  const descendantSet = new Set(descendantNodeIds);
  const ids = new Set<string>(descendantNodeIds);

  const labelByContainerId = new Map<string, ElementSummary>();
  for (const element of summaries) {
    if (element.containerId) labelByContainerId.set(element.containerId, element);
  }
  for (const id of descendantNodeIds) {
    const label = labelByContainerId.get(id);
    if (label) ids.add(label.id);
  }

  const edgesForMap = readMindMapEdges(summaries).get(node.relation.mapId) ?? [];
  for (const edge of edgesForMap) {
    const projection = readMindMapProjection(edge);
    if (projection && descendantSet.has(projection.childId)) ids.add(edge.id);
  }

  return { ids, nodeCount: descendantNodeIds.length };
}

/**
 * Toggle `nodeId`'s collapsed flag -- no layout run, same as `togglePinOps`:
 * a single customData patch, nothing else ever moves. Collapsing a leaf (no
 * children) is refused (`null`) -- there is nothing to hide, and the badge
 * this drives would show a nonsensical "0".
 */
export function toggleCollapseOps(
  summaries: readonly ElementSummary[],
  nodeId: string,
): SceneOp[] | null {
  const node = readMindMapNodes(summaries).find((n) => n.summary.id === nodeId);
  if (!node) return null;

  const collapsed = !(node.relation.collapsed === true);
  if (collapsed && collapsedHiddenIds(summaries, nodeId) === null) return null; // leaf

  return [
    {
      kind: "patch",
      id: nodeId as never,
      changes: {
        customData: withExcalidashData(node.summary, {
          mindMap: {
            ...node.relation,
            ...(collapsed ? { collapsed: true } : { collapsed: undefined }),
          },
        }),
      },
    },
  ];
}

/** The map id of a mind-map node, or null. */
export function mapIdOf(summary: ElementSummary | null | undefined): string | null {
  if (!summary) return null;
  return readMindMap(summary)?.mapId ?? null;
}

export { subtreeElementIds, compareStableStrings };
