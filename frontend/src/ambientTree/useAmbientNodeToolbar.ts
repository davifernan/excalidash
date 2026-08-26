/**
 * The floating toolbar for whichever single shape is selected (NIL-593,
 * Schnitt 3) -- ambient over any shape, not "a mind-map node". Carries
 * both Pin and Collapse: Pin needs no keyboard shortcut of its own (see
 * `useAmbientPinKey.ts`'s own deletion, Hans finding on this PR -- `P` is
 * Excalidraw's own native freedraw shortcut, and ambient pin/collapse now
 * runs on every board, for every selection, not just inside an opted-into
 * mind-map mode the way v1's identical key choice was scoped to). Reuses
 * the floating-toolbar mechanism this fork already committed to for a
 * per-element action (`ElementFloatingToolbar.tsx`, NIL-565/573/587)
 * rather than a hover affordance, and the exact `lastKey`-gated `setState`
 * shape `../mindMap/useMindMapCollapse.ts` (Schnitt 2's deleted
 * predecessor) measured as necessary: an eager recompute inside a
 * `useEffect`, or an unconditional `setToolbarTarget` on every
 * scene-change tick, both fed back into Excalidraw's own change detection
 * and crashed the editor with "Maximum update depth exceeded" (a real
 * browser run caught it, not a unit test). This hook only calls
 * `setState` when the selected node, its qualifying children, or its own
 * pinned/collapsed flags actually changed.
 *
 * Pin shows for any single selection (pinning a leaf is a legitimate,
 * harmless no-op ahead of the day it gains a bound arrow). Collapse shows
 * only when the node has ambient children AND is not already collapsed --
 * an already-collapsed node's own badge (`AmbientNodeOverlay.tsx`) is the
 * only expand control it needs.
 */
import { useRef, useState } from "react";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
} from "../integrations/excalidraw/capabilities";
import { readNodeState } from "../integrations/excalidraw/customData";
import type { FloatingToolbarTarget } from "../pages/editor/floatingToolbarGeometry";
import { elementViewportBounds } from "../pages/editor/floatingToolbarGeometry";
import { collapsedHiddenIds, toggleCollapseOps, togglePinOps } from "./nodeState";

type ToolbarState = {
  readonly target: FloatingToolbarTarget;
  readonly nodeId: string;
  readonly pinned: boolean;
  readonly canCollapse: boolean;
};

type Options = {
  canEdit: boolean;
  excalidrawRoot: HTMLElement | null;
  interaction: Pick<InteractionCapability, "read">;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
  viewport: Pick<ViewportCapability, "read">;
};

export function useAmbientNodeToolbar({
  canEdit,
  excalidrawRoot,
  interaction,
  scene,
  selection,
  viewport,
}: Options) {
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const lastKey = useRef<string | null>(null);

  const setKeyed = (key: string | null, next: ToolbarState | null) => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    setToolbar(next);
  };

  const onSceneChange = () => {
    if (!canEdit || !excalidrawRoot) {
      setKeyed(null, null);
      return;
    }
    const state = interaction.read();
    if (!state.ok || state.value.editingTextElementId) {
      setKeyed(null, null);
      return;
    }
    const selected = selection.read();
    if (!selected.ok || selected.value.selectedIds.length !== 1) {
      setKeyed(null, null);
      return;
    }
    const summaries = scene.summaries();
    if (!summaries.ok) {
      setKeyed(null, null);
      return;
    }
    const id = selected.value.selectedIds[0];
    const node = summaries.value.find((element) => !element.isDeleted && element.id === id);
    if (!node) {
      setKeyed(null, null);
      return;
    }
    const nodeState = readNodeState(node);
    const collapsed = nodeState?.collapsed === true;
    const canCollapse = !collapsed && collapsedHiddenIds(summaries.value, id) !== null;
    const viewportState = viewport.read();
    if (!viewportState.ok) {
      setKeyed(null, null);
      return;
    }
    const anchor = elementViewportBounds(node, viewportState.value);
    const key = `${id}:${anchor.left}:${anchor.top}:${anchor.right}:${anchor.bottom}:${nodeState?.pinned === true}:${canCollapse}`;
    setKeyed(key, {
      target: { host: excalidrawRoot, anchor },
      nodeId: id,
      pinned: nodeState?.pinned === true,
      canCollapse,
    });
  };

  const togglePin = (nodeId: string) => {
    if (!canEdit) return;
    const summaries = scene.summaries();
    if (!summaries.ok) return;
    const ops = togglePinOps(summaries.value, nodeId);
    if (ops) scene.apply(ops, { capture: "immediate" });
  };

  const toggleCollapse = (nodeId: string) => {
    if (!canEdit) return;
    const summaries = scene.summaries();
    if (!summaries.ok) return;
    const ops = toggleCollapseOps(summaries.value, nodeId);
    if (ops) scene.apply(ops, { capture: "immediate" });
  };

  return { onSceneChange, toolbar, togglePin, toggleCollapse };
}
