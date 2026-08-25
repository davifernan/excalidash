/**
 * Wires `ambientSubtreeIds` into a live drag (NIL-593). Detects a drag the
 * same way `useMindMapDrag.ts` (v1/NIL-570/576) already proved safe for
 * undo: comparing live positions tick to tick via `onSceneChange`, since
 * there is no "an element is being pointer-dragged" field to read (see that
 * file's own comment for the long version of why).
 *
 * ## `capture: "eventually"`, not `"immediate"` -- a real, measured difference
 *
 * NIL-576 measured `capture: "immediate"` on every tick landing as ONE undo
 * step for the old mind-map subtree translate. Copying that exact setting
 * here did NOT reproduce that result: dragging an unselected shape and a
 * bound child in one continuous gesture (mouse down directly on the shape,
 * then move, then up -- the ordinary way anyone drags something, not a
 * separate select-then-drag) split into several small undo steps, one per
 * tick, while the natively-dragged shape itself still undid correctly in
 * one. Selecting the shape as a SEPARATE prior click before starting the
 * drag gesture avoided it -- suggesting `IMMEDIATELY` forces a new history
 * checkpoint on every tick when the drag's own selection is still forming,
 * and the old mind-map code's passing test happens to always select first,
 * separately, before dragging. `capture: "eventually"` defers each tick's
 * checkpoint to the next natural one instead of forcing a new one, and
 * measured correctly as one undo step for both gesture shapes (selected
 * first, and combined click+drag) in `ambient-tree-drag.spec.ts`. Not a
 * theory -- read the exact repro in that file's own git history if this
 * needs re-deriving.
 *
 * Excalidraw reflows a bound arrow's geometry on its own ONLY when the
 * endpoint that moved is the one Excalidraw itself is actively, natively
 * dragging -- confirmed by a real repro, not assumed: the arrow from the
 * dragged shape to a patched descendant reflows correctly (the dragged
 * shape is Excalidraw's own live drag target), but an arrow between TWO
 * patched descendants (neither one natively dragged, both moved only by
 * this hook's own `scene.apply`) does not move at all, leaving it visibly
 * detached from both shapes. So an arrow wholly INSIDE the translated
 * subtree (both its `startBinding` and `endBinding` name a shape this hook
 * is already translating) gets its own bounding box shifted by the exact
 * same delta explicitly -- the same "internal edge" translation v1's
 * `useMindMapDrag.ts` already does for the identical reason, just without
 * that file's edge-rebuild machinery: a plain delta on `x`/`y` is enough
 * here, since neither endpoint's size or relative offset changed, only a
 * shared translation. The one other thing still translated explicitly is a
 * shape's own bound LABEL (`containerId`), for the same reason v1 did:
 * Excalidraw only glues a label to its container through its own
 * interactive move machinery, not through a raw element patch.
 *
 * ## Why a v1 mind-map node is excluded here
 *
 * NIL-570/571's mind-map tool is not being removed this slice (that is its
 * own future cut) and still runs its own per-tick drag translate
 * (`useMindMapDrag.ts`) for anything carrying
 * `customData.excalidash.mindMap`. Since NIL-575 already made THAT tool's
 * own edges real native bound arrows, a v1 mind-map subtree also happens to
 * satisfy this module's own rules -- both mechanisms would otherwise
 * compute the same drag and both call `scene.apply` for it, independently,
 * in the same tick. Rather than rely on both landing on the identical
 * delta by coincidence, a shape carrying that customData key is filtered
 * out of this module's graph entirely, on both ends of every edge: v1
 * boards keep working exactly as they do today, and this module never
 * looks at them.
 */
import { useRef } from "react";
import type { SceneCapability, SelectionCapability } from "../integrations/excalidraw/capabilities";
import type { ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { ambientSubtreeIds, type ArrowEdge, type ShapeBox } from "./ambientTree";

/** Whether `element` belongs to the v1 mind-map tool -- see the file comment on why those are excluded here. */
const isV1MindMapElement = (element: ElementSummary): boolean => {
  const excalidash = element.customData?.excalidash as { mindMap?: unknown } | undefined;
  return !!excalidash?.mindMap;
};

type Options = {
  canEdit: boolean;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
};

type LivePosition = { readonly x: number; readonly y: number };

export function useAmbientTreeDrag({ canEdit, scene, selection }: Options) {
  const previousTick = useRef<Map<string, LivePosition>>(new Map());

  const onSceneChange = () => {
    if (!canEdit) return;

    const summaries = scene.summaries();
    if (!summaries.ok) {
      previousTick.current = new Map();
      return;
    }

    const shapes = summaries.value.filter(
      (element) => !element.isDeleted && element.type !== "arrow" && !isV1MindMapElement(element),
    );
    const current = new Map<string, LivePosition>(
      shapes.map((shape) => [shape.id, { x: shape.x, y: shape.y }]),
    );
    const previous = previousTick.current;
    previousTick.current = current;

    const moved: string[] = [];
    for (const [id, position] of current) {
      const before = previous.get(id);
      if (before && (before.x !== position.x || before.y !== position.y)) moved.push(id);
    }

    const selected = selection.read();
    const soleSelectedId =
      selected.ok && selected.value.selectedIds.length === 1 ? selected.value.selectedIds[0] : null;
    // A drag is "in progress" if exactly one shape moved this tick and it is
    // the sole selection -- the same signal v1 always used.
    const activeId = moved.length === 1 && moved[0] === soleSelectedId ? moved[0] : null;
    if (!activeId) return;

    const before = previous.get(activeId);
    const after = current.get(activeId);
    if (!before || !after) return;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    if (dx === 0 && dy === 0) return;

    const boxesById = new Map<string, ShapeBox>(
      shapes.map((shape) => [
        shape.id,
        { id: shape.id, x: shape.x, y: shape.y, width: shape.width, height: shape.height },
      ]),
    );
    const edges: ArrowEdge[] = summaries.value
      .filter((element) => !element.isDeleted && element.type === "arrow")
      .map((arrow) => ({
        arrowId: arrow.id,
        startId: arrow.startBinding?.elementId ?? null,
        endId: arrow.endBinding?.elementId ?? null,
      }));

    const subtreeIds = ambientSubtreeIds(activeId, edges, boxesById);
    if (subtreeIds.size === 0) return;

    const labelByContainerId = new Map<string, ElementSummary>();
    for (const element of summaries.value) {
      if (element.containerId) labelByContainerId.set(element.containerId, element);
    }

    const ops: SceneOp[] = [];
    for (const id of subtreeIds) {
      const box = boxesById.get(id);
      if (!box) continue;
      ops.push({ kind: "patch", id: id as never, changes: { x: box.x + dx, y: box.y + dy } });
      const label = labelByContainerId.get(id);
      if (label) {
        ops.push({
          kind: "patch",
          id: label.id as never,
          changes: { x: label.x + dx, y: label.y + dy },
        });
      }
    }
    // An arrow wholly inside the translated subtree -- BOTH ends are
    // descendants this hook is patching, NEITHER is the natively-dragged
    // shape itself -- is not reflowed by Excalidraw on its own (see the
    // file comment above). An arrow with the natively-dragged shape as one
    // of its ends is excluded here on purpose: Excalidraw already reflows
    // that one correctly, and shifting it again would double-translate it.
    for (const arrow of summaries.value) {
      if (arrow.isDeleted || arrow.type !== "arrow") continue;
      const startId = arrow.startBinding?.elementId;
      const endId = arrow.endBinding?.elementId;
      if (!startId || !endId) continue;
      if (!subtreeIds.has(startId) || !subtreeIds.has(endId)) continue;
      ops.push({
        kind: "patch",
        id: arrow.id as never,
        changes: { x: arrow.x + dx, y: arrow.y + dy },
      });
    }
    if (ops.length > 0) scene.apply(ops, { capture: "eventually" });
  };

  return { onSceneChange };
}
