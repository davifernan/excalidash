/**
 * The floating "Collapse" toolbar for whichever single shape is selected
 * (NIL-593, Schnitt 3) -- ambient over any shape with qualifying ambient
 * children, not "a mind-map node". Reuses the floating-toolbar mechanism
 * this fork already committed to for a per-element action
 * (`ElementFloatingToolbar.tsx`, NIL-565/573/587) rather than a hover
 * affordance, and the exact `lastKey`-gated `setState` shape
 * `../mindMap/useMindMapCollapse.ts` (Schnitt 2's deleted predecessor)
 * measured as necessary: an eager recompute inside a `useEffect`, or an
 * unconditional `setToolbarTarget` on every scene-change tick, both fed
 * back into Excalidraw's own change detection and crashed the editor with
 * "Maximum update depth exceeded" (a real browser run caught it, not a
 * unit test). This hook only calls `setState` when the selected node, its
 * qualifying children, or its own collapsed flag actually changed.
 *
 * No toolbar for an already-collapsed node -- its own badge
 * (`AmbientCollapseOverlay.tsx`) is the only control it needs.
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
import { collapsedHiddenIds, toggleCollapseOps } from "./nodeState";

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
  const [toolbarTarget, setToolbarTarget] = useState<FloatingToolbarTarget | null>(null);
  const lastKey = useRef<string | null>(null);

  const setKeyed = (key: string | null, target: FloatingToolbarTarget | null) => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    setToolbarTarget(target);
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
    if (!node || readNodeState(node)?.collapsed === true) {
      setKeyed(null, null);
      return;
    }
    const hidden = collapsedHiddenIds(summaries.value, id);
    if (!hidden) {
      setKeyed(null, null);
      return;
    }
    const viewportState = viewport.read();
    if (!viewportState.ok) {
      setKeyed(null, null);
      return;
    }
    const anchor = elementViewportBounds(node, viewportState.value);
    const key = `${id}:${anchor.left}:${anchor.top}:${anchor.right}:${anchor.bottom}`;
    setKeyed(key, { host: excalidrawRoot, anchor });
  };

  const toggleCollapse = (nodeId: string) => {
    if (!canEdit) return;
    const summaries = scene.summaries();
    if (!summaries.ok) return;
    const ops = toggleCollapseOps(summaries.value, nodeId);
    if (ops) scene.apply(ops, { capture: "immediate" });
  };

  return { onSceneChange, toolbarTarget, toggleCollapse };
}
