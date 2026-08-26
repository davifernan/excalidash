/**
 * Computed render data for `AmbientNodeOverlay.tsx`, updated from an
 * explicit `onSceneChange` tick and gated by a signature comparison
 * (NIL-598) -- the same shape `useAmbientNodeToolbar.ts` already uses for
 * the floating toolbar, and for the same reason.
 *
 * ## Why "computed fresh on each render" was not actually fresh
 *
 * `AmbientNodeOverlay.tsx` used to call `scene.summaries()`/`viewport.read()`
 * directly inside its own render body, on the theory that it would recompute
 * "on each render" the way `MindMapDropHighlight.tsx` does. That is true only
 * if something actually re-renders it. `Editor.tsx`'s own `onChange` handler
 * (`handleChangeWithSelection`) calls `setHasSelection(nextValue)` on every
 * scene tick, local or remote -- but React skips the re-render entirely when
 * `nextValue` is identical to the current state (its own same-value setState
 * bailout). A client that only ever *watches* a board (never selects
 * anything itself) has `hasSelection` pinned at `false` forever, so a
 * collapse toggled by someone else updates the scene correctly but never
 * gets a chance to redraw on that client -- proven live
 * (`mind-map-pin-collapse.spec.ts`'s own "collapse on one client is visible
 * on another" test, measured failing ~8% of local runs, NIL-598): the very
 * next assertion (`nodeState.collapsed` present on the guest) is green, so
 * the data update is not in question, only whether anything told React to
 * look at it again. The exact same shape as NIL-593 Schnitt 2's arrow-
 * geometry bug: metadata set, nothing drawn, every data-level check green.
 *
 * The fix is the same one `useAmbientNodeToolbar.ts` already had to solve
 * for its own floating-toolbar anchor: don't depend on an incidental
 * re-render from somewhere else. Compute the full render payload on every
 * `onSceneChange` tick (wired the same way, from `Editor.tsx`'s
 * `handleChangeWithSelection`), and call `setState` -- which unconditionally
 * schedules a real re-render -- only when the computed payload's own JSON
 * signature actually differs from the last one. A genuine remote collapse/
 * pin change always produces a different signature, so it is never silently
 * skipped; nothing on screen ever changed for a tick, so nothing gets
 * redrawn -- which is also why this cannot reintroduce the
 * "Maximum update depth exceeded" crash `useAmbientNodeToolbar.ts`'s own
 * file comment documents: that crash came from calling `setState`
 * UNCONDITIONALLY on every tick, not from computing on every tick.
 */
import { useRef, useState } from "react";
import type { SceneCapability, ViewportCapability } from "../integrations/excalidraw/capabilities";
import type { ElementSummary } from "../integrations/excalidraw/types";
import { elementViewportBounds } from "../pages/editor/floatingToolbarGeometry";
import { collapsedHiddenIds, collapsedNodeIds, pinnedNodeIds } from "./nodeState";

export type CollapseMask = {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type CollapseBadge = {
  readonly nodeId: string;
  readonly nodeCount: number;
  readonly left: number;
  readonly top: number;
};

export type PinBadge = {
  readonly nodeId: string;
  readonly left: number;
  readonly top: number;
};

export type AmbientOverlayState = {
  readonly masks: readonly CollapseMask[];
  readonly collapseBadges: readonly CollapseBadge[];
  readonly pinBadges: readonly PinBadge[];
};

const EMPTY: AmbientOverlayState = { masks: [], collapseBadges: [], pinBadges: [] };

type Options = {
  container: HTMLElement | null;
  scene: Pick<SceneCapability, "summaries">;
  viewport: Pick<ViewportCapability, "read">;
};

export function useAmbientOverlayState({ container, scene, viewport }: Options) {
  const [state, setState] = useState<AmbientOverlayState>(EMPTY);
  const lastKey = useRef<string | null>(null);

  const setKeyed = (key: string | null, next: AmbientOverlayState) => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    setState(next);
  };

  const onSceneChange = () => {
    if (!container) {
      setKeyed(null, EMPTY);
      return;
    }
    const summaries = scene.summaries();
    const viewportState = viewport.read();
    if (!summaries.ok || !viewportState.ok) {
      setKeyed(null, EMPTY);
      return;
    }
    // The portal renders inside `container`, so every position here is
    // relative to it, the same subtraction the pre-fix inline render used.
    const hostRect = container.getBoundingClientRect();

    const byId = new Map<string, ElementSummary>(
      summaries.value.map((element) => [element.id, element]),
    );

    const masks: CollapseMask[] = [];
    const collapseBadges: CollapseBadge[] = [];
    for (const nodeId of collapsedNodeIds(summaries.value)) {
      const hidden = collapsedHiddenIds(summaries.value, nodeId);
      const node = byId.get(nodeId);
      if (!hidden || !node) continue; // stale flag on a leaf, or the node itself is gone

      for (const hiddenId of hidden.ids) {
        const element = byId.get(hiddenId);
        if (!element) continue;
        const bounds = elementViewportBounds(element, viewportState.value);
        masks.push({
          id: hiddenId,
          left: bounds.left - hostRect.left,
          top: bounds.top - hostRect.top,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top,
        });
      }

      const nodeBounds = elementViewportBounds(node, viewportState.value);
      collapseBadges.push({
        nodeId,
        nodeCount: hidden.nodeCount,
        left: nodeBounds.right - hostRect.left - 20,
        top: nodeBounds.bottom - hostRect.top - 14,
      });
    }

    const pinBadges: PinBadge[] = [];
    for (const nodeId of pinnedNodeIds(summaries.value)) {
      const node = byId.get(nodeId);
      if (!node) continue;
      const bounds = elementViewportBounds(node, viewportState.value);
      pinBadges.push({
        nodeId,
        left: bounds.left - hostRect.left - 8,
        top: bounds.top - hostRect.top - 8,
      });
    }

    const next: AmbientOverlayState = { masks, collapseBadges, pinBadges };
    setKeyed(JSON.stringify(next), next);
  };

  return { state, onSceneChange };
}
