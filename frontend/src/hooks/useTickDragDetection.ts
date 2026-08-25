/**
 * Detects a live drag from ordinary scene snapshots, comparing positions
 * tick to tick -- there is no "an element is being pointer-dragged" signal
 * to read directly (`appState.draggingElement` only covers an element still
 * being *drawn*, never one being moved; see `useMindMapDrag.ts`'s git
 * history for the long version, NIL-570/NIL-576).
 *
 * A drag is "in progress" if exactly one tracked id moved this tick and it
 * is the sole selection; anything else (0, 2+, or a selection mismatch)
 * means no drag is happening right now. Shared by `useMindMapDrag.ts`
 * (NIL-570) and `useAmbientTreeDrag.ts` (NIL-593), which both derive this
 * the same way (PR #175 review, Low finding: two near-identical copies of
 * this exact comparison were a real seam once there were two).
 *
 * This hook only answers "did a local-looking tick just happen" -- it does
 * not know whether the tick actually originated from this client's own
 * pointer or from an incoming realtime-sync scene replace that happens to
 * look identical (single element moved, matching this client's current
 * sole selection). A caller whose own effect is not idempotent under a
 * spurious re-trigger -- `useAmbientTreeDrag.ts` translates a whole bound
 * subtree again on every match -- must additionally gate on its own
 * "is a remote sync currently being applied" signal before acting on the
 * result (see that file's own comment, PR #175 review, Medium finding).
 */
import { useRef } from "react";

type LivePosition = { readonly x: number; readonly y: number };

export type TrackedPosition = { readonly id: string; readonly x: number; readonly y: number };

export type DragTick = {
  readonly activeId: string;
  readonly before: LivePosition;
  readonly after: LivePosition;
};

export function useTickDragDetection() {
  const previousTick = useRef<Map<string, LivePosition>>(new Map());

  const detect = (
    positions: readonly TrackedPosition[],
    soleSelectedId: string | null,
  ): DragTick | null => {
    const current = new Map<string, LivePosition>(
      positions.map((position) => [position.id, { x: position.x, y: position.y }]),
    );
    const previous = previousTick.current;
    previousTick.current = current;

    const moved: string[] = [];
    for (const [id, position] of current) {
      const before = previous.get(id);
      if (before && (before.x !== position.x || before.y !== position.y)) moved.push(id);
    }

    const activeId = moved.length === 1 && moved[0] === soleSelectedId ? moved[0] : null;
    if (!activeId) return null;
    const before = previous.get(activeId);
    const after = current.get(activeId);
    if (!before || !after) return null;
    return { activeId, before, after };
  };

  /** Drop the remembered positions -- the next tick starts with no baseline to compare against. */
  const reset = () => {
    previousTick.current = new Map();
  };

  return { detect, reset };
}
