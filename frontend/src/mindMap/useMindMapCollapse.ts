/**
 * Collapse a branch: hide its descendants behind a client-local overlay
 * (`MindMapCollapseOverlay.tsx`) and a count badge on the collapsed node
 * itself, which is also the un-collapse control (NIL-571 v2, third slice).
 *
 * ## Where the "collapse" action lives (NIL-587's own research, applied)
 *
 * The prior art surveyed on NIL-587 (Miro) puts collapse behind a
 * hover-appearing minus button on the branch itself. That fits Miro's own
 * chrome, not this fork's: ExcaliDash already has one deliberate mechanism
 * for "an action that applies to whichever single element is selected" --
 * the floating element toolbar (NIL-565/573, `ElementFloatingToolbar.tsx`),
 * already used for the asset widget's controls. A hover-only affordance
 * would be a second, inconsistent way to reach a per-element action; the
 * floating toolbar is the one this fork already committed to, so collapse
 * reuses it rather than inventing a hover state to match Miro's own chrome.
 * Un-collapsing does NOT go through the toolbar at all -- NIL-587's second
 * adopted point is that the count badge doubles as the expand control, so a
 * second button next to it would be redundant chrome for the same action.
 *
 * ## Why this never touches layout.ts or the descendants' own data
 *
 * Collapsing hides elements from view without altering them: the mask and
 * badge are pure React/DOM overlay, never Excalidraw elements, so a client
 * without this feature (or a plain JSON export reopened anywhere) still
 * sees the complete, unmodified subtree -- there is nothing for it to lose,
 * because nothing about the subtree's own data ever changes. See
 * `collapsedHiddenIds` in `mindMapScene.ts` for what gets masked and why the
 * incoming edge from the collapsed node's own parent stays visible.
 *
 * ## Why this has no `useEffect`/subscription of its own, and only sets
 * state on an actual change
 *
 * An earlier version subscribed to `interaction.subscribe` and
 * `viewport.subscribeScroll` in a `useEffect` to keep the toolbar target
 * fresh across pure selection/pan changes. `scene`/`selection`/`viewport`
 * are not stable references across renders in this adapter, so that effect
 * re-ran on every render, and its own eager `recompute()` call inside the
 * effect (itself a `setState`) re-triggered the same render it just came
 * from -- an infinite update loop, caught by a real browser run (the
 * existing `mind-map.spec.ts` delete test crashed the whole editor with
 * "Maximum update depth exceeded", not a mind-map-specific assertion).
 *
 * A second version dropped the effect but still called `setToolbarTarget`
 * unconditionally on every `onSceneChange` tick while a node with children
 * stayed selected -- a fresh object every tick, forever, portalled into the
 * SAME DOM subtree Excalidraw itself owns and watches
 * (`excalidrawRoot`). That reproduced the identical crash: `ElementFloatingToolbar`
 * re-mounting/re-measuring on every tick fed back into Excalidraw's own
 * change detection. `useMindMapDrag.ts`'s own `preview` state only ever
 * updates for the bounded duration of an actual pointer drag, never
 * "forever while something stays selected" -- this hook now matches that
 * shape: `lastKey` remembers what the toolbar target was last computed
 * from, and `setToolbarTarget` only runs when the selected node, its
 * children, or its collapsed flag actually changed, not on every tick that
 * merely re-confirms the same answer.
 */
import { useRef, useState } from "react";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
} from "../integrations/excalidraw/capabilities";
import type { FloatingToolbarTarget } from "../pages/editor/floatingToolbarGeometry";
import { elementViewportBounds } from "../pages/editor/floatingToolbarGeometry";
import { normalizeLiveMap, readMindMapNodes, toggleCollapseOps } from "./mindMapScene";

type Options = {
  canEdit: boolean;
  excalidrawRoot: HTMLElement | null;
  interaction: Pick<InteractionCapability, "read">;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
  viewport: Pick<ViewportCapability, "read">;
};

export function useMindMapCollapse({
  canEdit,
  excalidrawRoot,
  interaction,
  scene,
  selection,
  viewport,
}: Options) {
  const [toolbarTarget, setToolbarTarget] = useState<FloatingToolbarTarget | null>(null);
  // What the current `toolbarTarget` was last computed from -- `null` means
  // "no toolbar". Only a change to this key is allowed to call `setState`;
  // see the file comment for why re-confirming the same answer must not.
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
    const node = readMindMapNodes(summaries.value).find((n) => n.summary.id === id);
    // No toolbar for an already-collapsed node -- its own badge is the only
    // control it needs (NIL-587's second adopted point).
    if (!node || node.relation.collapsed === true) {
      setKeyed(null, null);
      return;
    }
    const normalized = normalizeLiveMap(summaries.value, node.relation.mapId);
    const hasChildren = normalized.ok && normalized.value.nodes.some((n) => n.parentId === id);
    if (!hasChildren) {
      setKeyed(null, null);
      return;
    }
    const viewportState = viewport.read();
    if (!viewportState.ok) {
      setKeyed(null, null);
      return;
    }
    const anchor = elementViewportBounds(node.summary, viewportState.value);
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
