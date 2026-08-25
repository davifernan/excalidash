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
 */
import { useRef } from "react";
import type { SceneCapability, SelectionCapability } from "../integrations/excalidraw/capabilities";
import type { ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { readMindMapProjection } from "../integrations/excalidraw/customData";
import { createMindMapEdge, newMindMapElementId } from "./mindMapElements";
import { normalizeLiveMap, readMindMapEdges, readMindMapNodes } from "./mindMapScene";
import { subtreeElementIds } from "./model";

type Options = {
  canEdit: boolean;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
};

type LivePosition = { readonly x: number; readonly y: number };

/**
 * Known gap, tracked as NIL-576: the follow-up patch below lands after
 * Excalidraw's own drag already committed its one history step, so it is a
 * second step rather than folded into the first. One user drag currently
 * undoes in two steps. Closing that needs `SceneCapability` to expose a way
 * to extend the in-flight history capture, which is shared-contract growth
 * this package is not making unilaterally mid-package (the same reasoning
 * `mindMapElements.ts` gives for not extending it for `boundElements`).
 */
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
    if (!selected.ok || selected.value.selectedIds.length !== 1 || selected.value.selectedIds[0] !== draggedId) {
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
    const parentById = new Map(normalized.value.nodes.map((node) => [node.elementId, node.parentId]));
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
      ops.push({ kind: "patch", id: elementId as never, changes: { x: live.x + dx, y: live.y + dy } });
      current.set(elementId, { x: live.x + dx, y: live.y + dy });
      // Same reasoning as `layoutOps` in mindMapScene.ts: a raw `patch` does
      // not carry the container's bound label along, so it is translated
      // here explicitly, by the same delta.
      const label = labelByContainerId.get(elementId);
      if (label) {
        ops.push({ kind: "patch", id: label.id as never, changes: { x: label.x + dx, y: label.y + dy } });
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
        // element, same delta, geometry (relative points) unchanged.
        ops.push({ kind: "patch", id: edge.id as never, changes: { x: edge.x + dx, y: edge.y + dy } });
      } else if (projection.childId === draggedId) {
        // The one edge crossing into the subtree: its parent end did not
        // move, so it is rebuilt from both boxes rather than translated.
        incomingEdge = edge;
      }
    }

    if (incomingEdge) {
      const parentId = parentById.get(draggedId);
      const parentLive = parentId ? liveById.get(parentId as never) : null;
      if (parentLive) {
        ops.push({ kind: "remove", ids: [incomingEdge.id] as never });
        ops.push({
          kind: "insert",
          elements: [
            createMindMapEdge(
              newMindMapElementId(),
              relation.mapId,
              draggedId,
              { x: parentLive.x, y: parentLive.y, width: parentLive.width, height: parentLive.height },
              { x: after.x, y: after.y, width: liveById.get(draggedId as never)?.width ?? 0, height: liveById.get(draggedId as never)?.height ?? 0 },
            ),
          ],
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
