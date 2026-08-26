/**
 * Pin and collapse, ambient over any subtree (NIL-593, Schnitt 3): no tool,
 * no mode, and no notion of "a mind-map node" -- any shape with qualifying
 * outgoing edges (`ambientTreeRootedAt`'s own rule, the same one drag-follow
 * and "Arrange" already use) can be pinned or collapsed. The decided
 * storage contract (NIL-593 Multica thread, measured against
 * `@excalidraw/excalidraw`'s own source, not assumed): both facts live in
 * `customData.excalidash.nodeState`, a per-node field with no structural
 * meaning of its own -- never in the arrow bindings, which is what defines
 * structure now that `mapId`/`parentId`/`orderKey` are gone. That thread's
 * own three-way comparison (native Excalidraw fields, page-level React
 * state, a separate server table) is what ruled out the alternatives; see
 * `../integrations/excalidraw/customData.ts`'s header for the short form.
 *
 * "Pinned" means: this node's own position survives the next explicit
 * "Arrange" run (`../mindMap/mindMapScene.ts`'s `arrangeOps` reads
 * `pinnedNodeIds` from here). "Collapsed" means: this node's own ambient
 * descendants are masked from view by `AmbientNodeOverlay.tsx` -- a purely
 * client-local rendering decision, never a scene mutation. Neither toggle
 * ever triggers a layout run.
 *
 * ## A `customData`-only patch is not undo-able -- measured, not assumed
 *
 * A patch that changes ONLY `customData` (`capture: "immediate"` or
 * `"eventually"`, either one) never becomes an undo step: the element's own
 * `version`/`versionNonce` bump correctly and the change is genuinely
 * live, but a real browser run (this schnitt's own e2e proof,
 * `mind-map-pin-collapse.spec.ts`) measured that `Ctrl+Z` right afterward
 * does nothing at all. The one existing precedent in this codebase for a
 * `customData`-only write never actually tested this: `StickyPalette.tsx`'s
 * `pick()` always changes `backgroundColor`/`strokeColor` in the SAME
 * patch as `customData`, never `customData` alone. An A/B check (adding a
 * genuinely different `strokeColor` value to an otherwise-identical patch)
 * confirmed the presence of that second, visibly-different field is what
 * makes the whole patch undo-able, not the capture mode.
 *
 * Overwriting `strokeColor` the way v1's own pin did is not available here
 * the way it was there: v1 only ever touched its own auto-generated nodes
 * (always the same default stroke); pin is ambient now, so it can land on
 * a hand-drawn shape whose stroke colour the person chose on purpose --
 * silently overwriting that on every pin/unpin would be real, surprising
 * data loss, unrelated to what pin is even supposed to do. `opacity` is
 * the safe substitute: a single point out of 100 is not humanly visible on
 * any element, at any zoom level this product supports (confirmed by eye
 * against the fixtures this file's own tests build), and each toggle nudges
 * by an exact, symmetric `OPACITY_NUDGE` that its own reverse toggle
 * exactly undoes -- pin and collapse nudge independently, so a node that is
 * both pinned and collapsed is nudged twice and restored by unwinding both,
 * in either order. `AmbientNodeOverlay.tsx`'s own pin badge and collapse
 * mask/badge are what a person actually sees; the opacity nudge exists
 * only so Excalidraw's own history agrees there was something to undo.
 *
 * Known, narrow, accepted gap: if `opacity` is already at the boundary
 * (`0`) when a nudge would push it further past `0`, the clamp leaves the
 * value unchanged and the same undo failure this comment describes
 * reappears for that one edge case. Not solved here: an element pinned at
 * `opacity: 0` is already invisible, and accepting one narrow, honestly
 * documented gap beats adding direction-tracking state the decided
 * `nodeState` contract (`{ pinned?, collapsed? }`, NIL-593 Multica thread)
 * does not have room for.
 */
import { readNodeState, withExcalidashData } from "../integrations/excalidraw/customData";
import type { ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { ambientSubtreeIds, boxesById, edgesOf, shapesOf } from "./ambientTree";

const OPACITY_NUDGE = 1;
const nudgeOpacity = (opacity: number, direction: 1 | -1): number =>
  Math.min(100, Math.max(0, opacity + direction * OPACITY_NUDGE));

/** Every shape id in `summaries` whose hand-set position an "Arrange" run must not discard. */
export function pinnedNodeIds(summaries: readonly ElementSummary[]): ReadonlySet<string> {
  return new Set(
    summaries
      .filter((element) => !element.isDeleted && readNodeState(element)?.pinned === true)
      .map((element) => element.id),
  );
}

/** Every shape id in `summaries` currently collapsed. */
export function collapsedNodeIds(summaries: readonly ElementSummary[]): ReadonlySet<string> {
  return new Set(
    summaries
      .filter((element) => !element.isDeleted && readNodeState(element)?.collapsed === true)
      .map((element) => element.id),
  );
}

/**
 * Toggle `nodeId`'s pinned flag: no layout run, ever -- exactly
 * `../mindMap/mindMapScene.ts`'s own "a command changes data, never
 * triggers layout by itself" rule. `null` for an unknown node. The
 * `opacity` nudge alongside `customData` is not cosmetic -- see this
 * file's own header comment for why a `customData`-only patch silently
 * fails to become an undo step at all.
 */
export function togglePinOps(
  summaries: readonly ElementSummary[],
  nodeId: string,
): readonly SceneOp[] | null {
  const node = summaries.find((element) => !element.isDeleted && element.id === nodeId);
  if (!node) return null;

  const current = readNodeState(node);
  const pinned = !(current?.pinned === true);
  return [
    {
      kind: "patch",
      id: nodeId as never,
      changes: {
        customData: withExcalidashData(node, { nodeState: nextNodeState(current, { pinned }) }),
        opacity: nudgeOpacity(node.opacity, pinned ? -1 : 1),
      } as never,
    },
  ];
}

/**
 * Every element id `nodeId`'s own collapse should hide: its ambient
 * descendants (via `ambientSubtreeIds` -- the same direction/single-parent/
 * direction-consistency rule drag-follow and "Arrange" already use, so
 * collapse never hides more than a drag would ever move), their bound
 * labels, and every edge whose child endpoint lands inside that descendant
 * set -- but never `nodeId` itself, nor the one edge coming *into* `nodeId`
 * from wherever it is bound, so a collapsed branch still reads as "there is
 * more here". `null` for an unknown node or a genuine leaf (nothing
 * qualifies as a descendant -- same silence-over-guessing the drag rule
 * already applies to a decision point or a cycle).
 */
export function collapsedHiddenIds(
  summaries: readonly ElementSummary[],
  nodeId: string,
): { readonly ids: ReadonlySet<string>; readonly nodeCount: number } | null {
  const shapes = shapesOf(summaries);
  if (!shapes.some((shape) => shape.id === nodeId)) return null;

  const edges = edgesOf(summaries);
  const descendants = ambientSubtreeIds(nodeId, edges, boxesById(shapes));
  if (descendants.size === 0) return null;

  const ids = new Set<string>(descendants);
  const labelByContainerId = new Map<string, ElementSummary>();
  for (const element of summaries) {
    if (element.containerId) labelByContainerId.set(element.containerId, element);
  }
  for (const id of descendants) {
    const label = labelByContainerId.get(id as never);
    if (label) ids.add(label.id);
  }
  for (const edge of edges) {
    if (edge.endId && descendants.has(edge.endId)) ids.add(edge.arrowId);
  }

  return { ids, nodeCount: descendants.size };
}

/**
 * Toggle `nodeId`'s collapsed flag, same as `togglePinOps`: nothing else
 * ever moves except the same undo-compatibility `opacity` nudge (see this
 * file's own header comment). Collapsing a leaf (nothing qualifies as a
 * descendant) is refused (`null`): there is nothing to hide, and the badge
 * this drives would show a nonsensical "0".
 */
export function toggleCollapseOps(
  summaries: readonly ElementSummary[],
  nodeId: string,
): readonly SceneOp[] | null {
  const node = summaries.find((element) => !element.isDeleted && element.id === nodeId);
  if (!node) return null;

  const current = readNodeState(node);
  const collapsed = !(current?.collapsed === true);
  if (collapsed && collapsedHiddenIds(summaries, nodeId) === null) return null; // leaf

  return [
    {
      kind: "patch",
      id: nodeId as never,
      changes: {
        customData: withExcalidashData(node, { nodeState: nextNodeState(current, { collapsed }) }),
        opacity: nudgeOpacity(node.opacity, collapsed ? -1 : 1),
      } as never,
    },
  ];
}

/**
 * The next `nodeState` after toggling one field, keeping the other intact
 * (unpinning a node that is also collapsed must not silently uncollapse
 * it, and vice versa) -- `null` once neither field would be `true`, so
 * `withExcalidashData` drops the field entirely rather than leaving a
 * `{}` husk behind.
 */
const nextNodeState = (
  current: { readonly pinned?: boolean; readonly collapsed?: boolean } | null,
  change: { readonly pinned?: boolean } | { readonly collapsed?: boolean },
): { readonly pinned?: boolean; readonly collapsed?: boolean } | null => {
  const merged = { ...current, ...change };
  const pinned = merged.pinned === true ? true : undefined;
  const collapsed = merged.collapsed === true ? true : undefined;
  if (!pinned && !collapsed) return null;
  return { ...(pinned ? { pinned } : {}), ...(collapsed ? { collapsed } : {}) };
};
