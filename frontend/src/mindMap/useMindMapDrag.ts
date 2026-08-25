/**
 * A dragged mind-map node either takes its whole subtree along rigidly (v1,
 * NIL-570), or -- new in v2 (NIL-571) -- reparents under whatever node it is
 * dropped onto. Both are exactly one atomic command with exactly one undo
 * step, and layout never runs on its own (NIL-570's central rule).
 *
 * ## Detecting a drag without a drag signal
 *
 * There is no "an existing element is being pointer-dragged" field to read
 * -- see the long version of this reasoning in this file's git history
 * (NIL-570/NIL-576): `appState.draggingElement` only covers an element still
 * being *drawn*, never one being moved. This hook still detects a drag from
 * ordinary scene snapshots via `onSceneChange`, comparing live positions
 * tick to tick -- the actual comparison lives in the shared
 * `useTickDragDetection` (`frontend/src/hooks/`), extracted once
 * `useAmbientTreeDrag.ts` (NIL-593) needed the identical logic (PR #175
 * review, Low finding). This hook's own tick-to-tick collision window (two
 * people dragging/selecting the exact same node in the exact same actively-
 * used mind map) stays exactly as narrow as it always was; unlike
 * `useAmbientTreeDrag.ts`, this hook does not additionally guard against an
 * incoming realtime-sync tick being misread as a local one -- that guard
 * was added there because ambient mode runs this same detection over every
 * bound shape on every board, not because this file's own copy started
 * doing anything differently.
 *
 * ## v2: per-tick translate, end-of-drag reparent decision (NIL-571)
 *
 * v1 corrected the subtree on *every* tick a drag produced, unconditionally
 * -- safe there because translating is idempotent-by-delta: whatever the
 * pointer's current position is, sliding the rest of the subtree by the
 * same delta is always correct, mid-drag or not, and NIL-576 confirmed the
 * whole sequence still lands as one undo step. v2 keeps exactly that
 * per-tick translate, unchanged, so the drag still tracks the pointer live
 * and the existing single-undo-step guarantee still holds.
 *
 * Reparenting is decided exactly once per drag, from a real `pointerup` on
 * `window` (bubble phase, after Excalidraw's own drag handling has already
 * run) -- not inferred from a tick where "nothing moved". The per-tick
 * translate above (specifically, rebuilding the one *incoming* edge as a
 * fresh bound arrow, NIL-575) itself produces a scene change with no `x`/`y`
 * delta on anything, which `onSceneChange` cannot tell apart from a real
 * pause in the drag -- inferring "the drag just ended" from that signal
 * fired on every single tick, not just the last one, and would reparent
 * onto the first node the drag happened to sit over mid-transit rather than
 * the one it is actually dropped on. `pointerup` has no such echo.
 *
 * A drop that lands on a node already excluded as part of the dragged
 * subtree (an attempted cycle) or outside the dragged node's map (cross-map)
 * cannot reach `reparentOps` at all: `dropTargetFor` only ever searches the
 * *same* map and already excludes the subtree from its candidates. A
 * rejection from `reparentOps` itself (defensive -- not reachable through
 * this geometric search today) just leaves the node exactly where the
 * per-tick translate already put it, a plain move rather than a lost node.
 */
import { useEffect, useRef, useState } from "react";
import { useTickDragDetection, type TrackedPosition } from "../hooks/useTickDragDetection";
import type { SceneCapability, SelectionCapability } from "../integrations/excalidraw/capabilities";
import type { BoundElementRef, ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { readMindMapProjection } from "../integrations/excalidraw/customData";
import { createMindMapEdge, mergeEdgeBinding, newMindMapElementId } from "./mindMapElements";
import {
  dropTargetFor,
  normalizeLiveMap,
  readMindMapEdges,
  readMindMapNodes,
  reparentOps,
} from "./mindMapScene";
import { subtreeElementIds } from "./model";

type Options = {
  canEdit: boolean;
  scene: Pick<SceneCapability, "apply" | "summaries" | "summaryById">;
  selection: Pick<SelectionCapability, "read">;
};

/** What a drag is doing right now, for `MindMapDropHighlight.tsx` to render. */
export type MindMapDragPreview = {
  readonly draggedId: string;
  /** The node the drag would reparent onto if released now, or null (no valid target under it -- a plain move). */
  readonly targetId: string | null;
};

export function useMindMapDrag({ canEdit, scene, selection }: Options) {
  const { detect, reset } = useTickDragDetection();
  const activeDragId = useRef<string | null>(null);
  const [preview, setPreview] = useState<MindMapDragPreview | null>(null);

  useEffect(() => {
    const onPointerUp = () => {
      const endedId = activeDragId.current;
      activeDragId.current = null;
      setPreview(null);
      if (!endedId) return;

      const settledSummaries = scene.summaries();
      if (!settledSummaries.ok) return;
      const settledNodes = readMindMapNodes(settledSummaries.value);
      const draggedNode = settledNodes.find((node) => node.summary.id === endedId);
      if (!draggedNode) return;

      const normalized = normalizeLiveMap(settledSummaries.value, draggedNode.relation.mapId);
      if (!normalized.ok) return;
      const excludeIds = new Set(subtreeElementIds(normalized.value, endedId));
      const center = {
        x: draggedNode.summary.x + draggedNode.summary.width / 2,
        y: draggedNode.summary.y + draggedNode.summary.height / 2,
      };
      const targetId = dropTargetFor(
        settledSummaries.value,
        draggedNode.relation.mapId,
        excludeIds,
        center,
      );
      if (!targetId || targetId === draggedNode.relation.parentId) return; // plain move: already handled per-tick

      const result = reparentOps(settledSummaries.value, endedId, targetId);
      if (result && result.ops.length > 0) scene.apply(result.ops, { capture: "immediate" });
    };

    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, [scene]);

  const onSceneChange = () => {
    if (!canEdit) return;

    const summaries = scene.summaries();
    if (!summaries.ok) {
      reset();
      activeDragId.current = null;
      setPreview(null);
      return;
    }

    const nodes = readMindMapNodes(summaries.value);
    const positions: TrackedPosition[] = nodes.map((node) => ({
      id: node.summary.id,
      x: node.summary.x,
      y: node.summary.y,
    }));

    const selected = selection.read();
    const soleSelectedId =
      selected.ok && selected.value.selectedIds.length === 1 ? selected.value.selectedIds[0] : null;

    const tick = detect(positions, soleSelectedId);

    if (tick) {
      const { activeId, before } = tick;
      const draggedNode = nodes.find((node) => node.summary.id === activeId);
      if (!draggedNode) return;

      activeDragId.current = activeId;

      const normalized = normalizeLiveMap(summaries.value, draggedNode.relation.mapId);
      if (normalized.ok) {
        const ops = translateSubtreeOps({
          summaries: summaries.value,
          mapId: draggedNode.relation.mapId,
          draggedId: activeId,
          draggedAfter: draggedNode.summary,
          dx: draggedNode.summary.x - before.x,
          dy: draggedNode.summary.y - before.y,
          movedIds: new Set(subtreeElementIds(normalized.value, activeId)),
          parentById: new Map(
            normalized.value.nodes.map((node) => [node.elementId, node.parentId]),
          ),
        });
        if (ops.length > 0) scene.apply(ops, { capture: "immediate" });
      }

      updatePreview(scene.summaries(), nodes, activeId);
      return;
    }

    // No drag active this tick -- either nothing is happening, or a drag
    // just ended and `pointerup` (above) will make the reparent decision.
    // Ticks with an incoming-edge rebuild but no `x`/`y` delta on anything
    // (see the file comment) also land here mid-drag; harmless, since there
    // is nothing left to do here either way.
  };

  const updatePreview = (
    summariesResult: ReturnType<SceneCapability["summaries"]>,
    nodes: readonly ReturnType<typeof readMindMapNodes>[number][],
    draggedId: string,
  ) => {
    if (!summariesResult.ok) {
      setPreview(null);
      return;
    }
    const summaries = summariesResult.value;
    const draggedNode = nodes.find((node) => node.summary.id === draggedId);
    if (!draggedNode) {
      setPreview(null);
      return;
    }
    const normalized = normalizeLiveMap(summaries, draggedNode.relation.mapId);
    const excludeIds = new Set(
      normalized.ok ? subtreeElementIds(normalized.value, draggedId) : [draggedId],
    );
    const center = {
      x: draggedNode.summary.x + draggedNode.summary.width / 2,
      y: draggedNode.summary.y + draggedNode.summary.height / 2,
    };
    const targetId = dropTargetFor(summaries, draggedNode.relation.mapId, excludeIds, center);
    setPreview({
      draggedId,
      targetId: targetId && targetId !== draggedNode.relation.parentId ? targetId : null,
    });
  };

  return { onSceneChange, preview };
}

type TranslateInput = {
  readonly summaries: readonly ElementSummary[];
  readonly mapId: string;
  readonly draggedId: string;
  readonly draggedAfter: ElementSummary;
  readonly dx: number;
  readonly dy: number;
  readonly movedIds: ReadonlySet<string>;
  readonly parentById: ReadonlyMap<string, string | null>;
};

/**
 * v1's rigid-subtree-translate, unchanged in behaviour: every other element
 * in the subtree (descendant nodes, their labels, and edges wholly inside
 * the subtree) moves by the same delta, and the one edge crossing into the
 * subtree from outside is rebuilt as a fresh real bound arrow (NIL-575).
 */
function translateSubtreeOps({
  summaries,
  mapId,
  draggedId,
  draggedAfter,
  dx,
  dy,
  movedIds,
  parentById,
}: TranslateInput): SceneOp[] {
  const liveById = new Map(summaries.map((element) => [element.id, element] as const));
  const labelByContainerId = new Map<string, ElementSummary>();
  for (const element of summaries) {
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
    const label = labelByContainerId.get(elementId);
    if (label) {
      ops.push({
        kind: "patch",
        id: label.id as never,
        changes: { x: label.x + dx, y: label.y + dy },
      });
    }
  }

  const edgesForMap = readMindMapEdges(summaries).get(mapId) ?? [];
  let incomingEdge: ElementSummary | null = null;
  for (const edge of edgesForMap) {
    const projection = readMindMapProjection(edge);
    if (!projection) continue;
    const parentId = parentById.get(projection.childId);
    const childMoved = movedIds.has(projection.childId);
    const parentMoved = parentId !== null && parentId !== undefined && movedIds.has(parentId);
    if (childMoved && parentMoved) {
      ops.push({
        kind: "patch",
        id: edge.id as never,
        changes: { x: edge.x + dx, y: edge.y + dy },
      });
    } else if (projection.childId === draggedId) {
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
            mapId,
            {
              id: parentId as string,
              x: parentLive.x,
              y: parentLive.y,
              width: parentLive.width,
              height: parentLive.height,
            },
            {
              id: draggedId,
              x: draggedAfter.x,
              y: draggedAfter.y,
              width: draggedAfter.width,
              height: draggedAfter.height,
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
          boundElements: mergeEdgeBinding(draggedAfter.boundElements, removedEdgeIds, [ref]),
        },
      });
    }
  }

  return ops;
}
