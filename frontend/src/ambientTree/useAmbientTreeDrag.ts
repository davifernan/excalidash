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
 *
 * ## Why an incoming realtime sync tick must not be read as a local drag
 * (PR #175 review, Medium finding)
 *
 * `useTickDragDetection`'s "exactly one tracked shape moved this tick and
 * it is the sole selection" signal is the same one `useMindMapDrag.ts`
 * always used, and was defensible there: it only ever ran inside one
 * actively-used mind map, so two people colliding on the exact same node at
 * the exact same instant was a narrow window. This module runs ambiently
 * over every bound shape on every board, for every collaborator, all the
 * time -- the same pattern inherited from v1 without inheriting the reason
 * it was safe there. Measured concretely: editor B has clicked a box (no
 * drag, just a selection) while editor A drags that exact box along with
 * its bound children. `onSceneChange` fires on every scene change
 * regardless of origin (`Editor.tsx`'s `handleChangeWithSelection` does not
 * distinguish a local pointer tick from an incoming realtime-sync scene
 * replace), so B's own `useTickDragDetection` sees A's synced tick land on
 * the shape B already has selected and reads it as B's own local drag --
 * translating the subtree a second time. A smoothly incremental drag's own
 * delta math happens to converge to the same numeric final position either
 * way (measured, see `ambient-tree-drag.spec.ts`'s own comment on its
 * `getAmbientTreeDragApplyCount` assertion) but the extra, unwanted
 * translate still genuinely runs on B, which is what this guards against.
 *
 * The obvious-looking fix would reuse `useEditorCollaboration.ts`'s
 * `isSyncing` ref, which is set `true` for the synchronous span of
 * `flushRemoteUpdates`'s own `scene.apply` call (`useEditorCanvasHandlers
 * .ts`'s `handleCanvasChange` already gates its first line on that exact
 * ref, to skip re-broadcasting a change this client did not originate) --
 * but a real two-context measurement (`ambient-tree-drag.spec.ts`) showed
 * it reads `false` by the time THIS hook's `onSceneChange` actually runs
 * for a remote-driven tick: Excalidraw's `onChange` prop does not fire
 * reentrantly inside that `scene.apply` call the way the file comment
 * above assumes for a *locally*-originated one -- it fires on a later
 * render pass, once `flushRemoteUpdates`'s own `finally` has already reset
 * the ref back to `false`. `appState.draggingElement` does not help either
 * (also measured): despite `Editor.tsx` exposing it to `StickyHandles` as
 * `isDragging`, it stayed `null` throughout a real drag of an *existing*
 * shape in this Excalidraw version -- it only ever covers an element still
 * being drawn, exactly as this file's own top comment already says.
 *
 * What actually works, because it needs neither of those: track the
 * client's own physical pointer state directly, via a plain
 * `pointerdown`/`pointerup` listener on `window`. A remote-sync tick can
 * land at any time regardless of whether *this* client's mouse happens to
 * be down; requiring it to be down is what a genuine local drag actually
 * looks like, unconditionally, with no dependency on collaboration
 * internals or their exact timing.
 */
import { useEffect, useRef } from "react";
import { useTickDragDetection, type TrackedPosition } from "../hooks/useTickDragDetection";
import type { SceneCapability, SelectionCapability } from "../integrations/excalidraw/capabilities";
import type { ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { ambientSubtreeIds, type ArrowEdge, type ShapeBox } from "./ambientTree";

/** Whether `element` belongs to the v1 mind-map tool -- see the file comment on why those are excluded here. */
const isV1MindMapElement = (element: ElementSummary): boolean => {
  const excalidash = element.customData?.excalidash as { mindMap?: unknown } | undefined;
  return !!excalidash?.mindMap;
};

/**
 * Test-only counter, wired into `__EXCALIDASH_TEST__` the same way
 * `mindMapLayoutRunCount` is (NIL-570) -- how many times this hook actually
 * translated a subtree. Used by `ambient-tree-drag.spec.ts` to prove that a
 * client which never locally drags anything (only clicks to select) never
 * runs this at all, even while another client's drag syncs in (PR #175
 * review, Medium finding): the number itself can coincidentally still
 * converge to a numerically-correct final position even when this fires
 * wrongly (an incremental drag's own delta-from-known-baseline math happens
 * to match the real one), so the count of *applications*, not the resulting
 * position, is the reliable signal.
 */
let applyCount = 0;
export const ambientTreeDragApplyCount = (): number => applyCount;

type Options = {
  canEdit: boolean;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
};

export function useAmbientTreeDrag({ canEdit, scene, selection }: Options) {
  const { detect, reset } = useTickDragDetection();
  // Measured, not assumed: `useEditorCollaboration.ts`'s `isSyncing` ref
  // looked like the obvious signal (it is set for the synchronous span of
  // `flushRemoteUpdates`'s own `scene.apply` call, and
  // `useEditorCanvasHandlers.ts` already gates on it for a related reason)
  // but a real two-context repro (`ambient-tree-drag.spec.ts`) showed it
  // reads `false` by the time this hook's `onSceneChange` actually runs for
  // a remote-driven tick -- Excalidraw's `onChange` prop does not fire
  // reentrantly inside that `scene.apply` call, only on a later render pass
  // once `flushRemoteUpdates`'s own `finally` has already reset the ref.
  // Tracking the real pointer state directly sidesteps that timing gap
  // entirely: a remote-sync tick can land at any time regardless of this
  // client's own mouse state, so requiring the mouse to actually be held
  // down locally is a precise, self-contained substitute -- see this file's
  // own comment on the Medium finding for the full story.
  const isPointerDown = useRef(false);

  useEffect(() => {
    const onPointerDown = () => {
      isPointerDown.current = true;
    };
    const onPointerUp = () => {
      isPointerDown.current = false;
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const onSceneChange = () => {
    if (!canEdit) return;

    const summaries = scene.summaries();
    if (!summaries.ok) {
      reset();
      return;
    }

    const shapes = summaries.value.filter(
      (element) => !element.isDeleted && element.type !== "arrow" && !isV1MindMapElement(element),
    );
    const positions: TrackedPosition[] = shapes.map((shape) => ({
      id: shape.id,
      x: shape.x,
      y: shape.y,
    }));

    const selected = selection.read();
    const soleSelectedId =
      selected.ok && selected.value.selectedIds.length === 1 ? selected.value.selectedIds[0] : null;
    const tick = detect(positions, soleSelectedId);
    if (!tick) return;
    // Checked only once a tick otherwise looks like a local drag, not up
    // front: `detect` must still see every tick to keep its own position
    // baseline current, remote-driven or not.
    if (!isPointerDown.current) return;
    const { activeId, before, after } = tick;
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
    if (ops.length > 0) {
      applyCount += 1;
      scene.apply(ops, { capture: "eventually" });
    }
  };

  return { onSceneChange };
}
