/**
 * A dragged mind-map node takes its whole subtree along, rigidly, by the
 * same delta -- never by re-running layout (NIL-570's central rule).
 *
 * ## Detecting a drag without a drag signal
 *
 * There is no "an existing element is being pointer-dragged" field to read.
 * `InteractionState.creatingElementId`/`resizingElementId` cover drawing and
 * resizing; `appState.draggingElement` (the raw field `useStickyNotesFeature`
 * threads into `Editor.tsx` as `isDragging`) is Excalidraw's own name for an
 * element still being *drawn*, not an existing one being moved -- true for
 * exactly zero of the ticks in a plain move-a-selected-shape gesture. Using
 * it here looked plausible, compiled, passed every jsdom unit test, and
 * simply never fired in a real browser: `mind-map.spec.ts`'s drag test is
 * what actually caught it (a grandchild that never moved), because the
 * jsdom tests mount no real Excalidraw host and cannot exercise a pointer
 * gesture at all.
 *
 * So this hook detects a drag itself, from ordinary scene snapshots, via
 * `onSceneChange` -- the same externally-driven channel
 * `useMindMapIntegrity.ts` uses, and for the same reason: this capability's
 * own `scene.subscribe` wraps `excalidrawAPI.onChange`, and the API is
 * handed over asynchronously after first mount, so a raw subscription taken
 * eagerly on mount can permanently miss it (also only visible in a real
 * browser run, not jsdom).
 *
 * The distinguishing signal: on every scene change, compare live positions
 * of every mind-map node in this map against the position each one held on
 * the *previous* change. A plain drag moves exactly one element (the one
 * Excalidraw's own pointer machinery is dragging) between two consecutive
 * changes. Every other kind of move this package makes -- `addNodeOps`'s
 * layout pass, `arrangeOps`, and this hook's own subtree correction --
 * writes several elements' positions in the same batch. So "exactly one
 * mind-map node's position changed since last tick, and it is the sole
 * selected element" is drag, and anything else (zero moved, several moved)
 * is not touched here. The one pathological case this can't tell apart from
 * a drag -- a lone selected node with no siblings, moved by a genuine
 * layout run that happens to touch only that one element -- does not arise
 * for a subtree drag *by definition*: layout never runs from a drag, and
 * the only single-element layout write is a brand-new root, which has no
 * parent/subtree edge for this hook to touch and so is a harmless no-op
 * even if this hook does look at it.
 *
 * ## NIL-576: one undo, verified -- but not by the mechanism first assumed
 *
 * NIL-570's own handoff claimed this follow-up patch was "a second, separate
 * undo step" -- reasoned from source (`store.commit()` runs before
 * `props.onChange` in `componentDidUpdate`, so a correction issued from this
 * hook's `onSceneChange` necessarily lands after the native drag's own
 * capture), but never actually pressed `Ctrl+Z` in a browser to check. It
 * was wrong: measured directly (two-node subtree drag, then one `Ctrl+Z`),
 * a single undo fully reverts the dragged node AND the rest of the subtree
 * together, every time (`mind-map-native-binding.spec.ts`). Something in
 * Excalidraw's own store folds this hook's `capture: "immediate"`
 * correction into the same history entry as the native drag despite the
 * two `scene.apply`/native-`setState` calls being chronologically separate
 * -- not fully isolated (candidates: how `Snapshot.maybeClone` diffs
 * against the pre-drag baseline rather than a just-native-committed one;
 * some rapid-successive-capture coalescing in the store), but the practical
 * outcome is exactly the epic's contract and is now pinned down by a real
 * test rather than left as an assumption either way.
 *
 * A different fix was tried first and **rejected** on measurement, not
 * theory -- worth recording so nobody reaches for it again expecting it to
 * help: a `pointerup` listener in the DOM **capture phase** on the editor
 * container (which does run before Excalidraw's own bubble-phase/`window`
 * listener for the same event -- confirmed in `dist/dev/index.js`,
 * `window.addEventListener("pointerup", onPointerUp)`, no capture flag),
 * issuing this hook's correction *before* Excalidraw's own native-drag
 * capture instead of after. Measured against the same scenario, it made
 * things *worse*: two separate undo steps, in the opposite order (the
 * native move reverted first, the subtree correction needed a second,
 * separate `Ctrl+Z`). Reordering which `setState` fires first inside the
 * same native event does not make React 18 batch them into one commit here
 * -- whatever mechanism gives the plain `onSceneChange`-after ordering its
 * single-entry behaviour, firing before breaks it. So this hook fires its
 * correction from `onSceneChange`, same as it always has; the fix for
 * NIL-576 turned out to be the test, not the code.
 */
import { useRef } from "react";
import type { SceneCapability, SelectionCapability } from "../integrations/excalidraw/capabilities";
import type { BoundElementRef, ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { readMindMapProjection } from "../integrations/excalidraw/customData";
import { createMindMapEdge, mergeEdgeBinding, newMindMapElementId } from "./mindMapElements";
import { normalizeLiveMap, readMindMapEdges, readMindMapNodes } from "./mindMapScene";
import { subtreeElementIds } from "./model";

type Options = {
  canEdit: boolean;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
};

type LivePosition = { readonly x: number; readonly y: number };

export function useMindMapDrag({ canEdit, scene, selection }: Options) {
  const previousPositions = useRef<Map<string, LivePosition>>(new Map());

  const onSceneChange = () => {
    if (!canEdit) return;

    const summaries = scene.summaries();
    if (!summaries.ok) {
      previousPositions.current = new Map();
      return;
    }

    const nodes = readMindMapNodes(summaries.value);
    const current = new Map<string, LivePosition>(
      nodes.map((node) => [node.summary.id, { x: node.summary.x, y: node.summary.y }]),
    );
    const previous = previousPositions.current;
    previousPositions.current = current;

    const moved: string[] = [];
    for (const [id, position] of current) {
      const before = previous.get(id);
      if (before && (before.x !== position.x || before.y !== position.y)) moved.push(id);
    }
    if (moved.length !== 1) return;

    const [draggedId] = moved;
    const selected = selection.read();
    if (
      !selected.ok ||
      selected.value.selectedIds.length !== 1 ||
      selected.value.selectedIds[0] !== draggedId
    ) {
      return;
    }

    const before = previous.get(draggedId);
    const after = current.get(draggedId);
    if (!before || !after) return;
    const dx = after.x - before.x;
    const dy = after.y - before.y;

    const draggedNode = nodes.find((node) => node.summary.id === draggedId);
    if (!draggedNode) return;
    const relation = draggedNode.relation;

    const normalized = normalizeLiveMap(summaries.value, relation.mapId);
    if (!normalized.ok) return;

    const movedIds = new Set(subtreeElementIds(normalized.value, draggedId));
    const parentById = new Map(
      normalized.value.nodes.map((node) => [node.elementId, node.parentId]),
    );
    const liveById = new Map(summaries.value.map((element) => [element.id, element] as const));
    const labelByContainerId = new Map<string, ElementSummary>();
    for (const element of summaries.value) {
      if (element.containerId) labelByContainerId.set(element.containerId, element);
    }

    const ops: SceneOp[] = [];
    for (const elementId of movedIds) {
      if (elementId === draggedId) continue; // Excalidraw already moved this one (label included).
      const live = liveById.get(elementId as never);
      if (!live) continue;
      ops.push({
        kind: "patch",
        id: elementId as never,
        changes: { x: live.x + dx, y: live.y + dy },
      });
      current.set(elementId, { x: live.x + dx, y: live.y + dy });
      // Same reasoning as `layoutOps` in mindMapScene.ts: a raw `patch` does
      // not carry the container's bound label along, so it is translated
      // here explicitly, by the same delta.
      const label = labelByContainerId.get(elementId);
      if (label) {
        ops.push({
          kind: "patch",
          id: label.id as never,
          changes: { x: label.x + dx, y: label.y + dy },
        });
      }
    }

    const edgesForMap = readMindMapEdges(summaries.value).get(relation.mapId) ?? [];
    let incomingEdge: ElementSummary | null = null;
    for (const edge of edgesForMap) {
      const projection = readMindMapProjection(edge);
      if (!projection) continue;
      const parentId = parentById.get(projection.childId);
      const childMoved = movedIds.has(projection.childId);
      const parentMoved = parentId !== null && parentId !== undefined && movedIds.has(parentId);
      if (childMoved && parentMoved) {
        // Wholly inside the moved subtree: translate like any other
        // element, same delta, geometry (relative points) and native
        // binding unchanged -- the arrow keeps the same id, so its
        // `startBinding`/`endBinding` and the shapes' `boundElements` stay
        // exactly as they were.
        ops.push({
          kind: "patch",
          id: edge.id as never,
          changes: { x: edge.x + dx, y: edge.y + dy },
        });
      } else if (projection.childId === draggedId) {
        // The one edge crossing into the subtree: its parent end did not
        // move, so it is rebuilt from both boxes rather than translated --
        // a fresh real bound arrow again (NIL-575), with `boundElements`
        // patched on both the surviving parent and the dragged node.
        incomingEdge = edge;
      }
    }

    if (incomingEdge) {
      const parentId = parentById.get(draggedId);
      const parentLive = parentId ? liveById.get(parentId as never) : null;
      if (parentLive) {
        const newEdgeId = newMindMapElementId();
        const removedEdgeIds = new Set([incomingEdge.id as string]);
        ops.push({ kind: "remove", ids: [incomingEdge.id] as never });
        ops.push({
          kind: "insert",
          elements: [
            createMindMapEdge(
              newEdgeId,
              relation.mapId,
              {
                id: parentId as string,
                x: parentLive.x,
                y: parentLive.y,
                width: parentLive.width,
                height: parentLive.height,
              },
              {
                id: draggedId,
                x: after.x,
                y: after.y,
                width: draggedNode.summary.width,
                height: draggedNode.summary.height,
              },
            ),
          ],
        });
        const ref: BoundElementRef = { id: newEdgeId as never, type: "arrow" };
        ops.push({
          kind: "patch",
          id: parentLive.id as never,
          changes: {
            boundElements: mergeEdgeBinding(parentLive.boundElements, removedEdgeIds, [ref]),
          },
        });
        ops.push({
          kind: "patch",
          id: draggedId as never,
          changes: {
            boundElements: mergeEdgeBinding(draggedNode.summary.boundElements, removedEdgeIds, [
              ref,
            ]),
          },
        });
      }
    }

    if (ops.length === 0) return;
    // `current` (now updated in place above) becomes the new baseline, so
    // the change this call itself makes is not re-detected as another drag
    // on the next tick.
    previousPositions.current = current;
    scene.apply(ops, { capture: "immediate" });
  };

  return { onSceneChange };
}
