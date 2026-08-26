/**
 * The mind-map feature, as one thing the editor page wires in (NIL-593,
 * Schnitt 2/3).
 *
 * Two explicit commands survive the mode teardown: "Import mind map..."
 * (paste an outline, preview, write once) and "Arrange" (lay out the
 * ambient subtree rooted at the current selection, respecting pinned
 * nodes). Pin and collapse (Schnitt 3, `../ambientTree/nodeState.ts` and
 * its `useAmbientNodeToolbar` hook) are ambient over ANY shape -- they are
 * wired in here rather than in `Editor.tsx` directly only because this is
 * already the file that owns the mind-map overlay slot, not because they
 * are a "mind map" concept; nothing in `ambientTree/` has ever heard of
 * one.
 *
 * Both live behind the SAME floating toolbar, with no keyboard shortcut
 * of their own (Hans finding on this PR): a `P` key for Pin was v1's own
 * choice, defensible there because v1's key handler only ever fired for
 * an actual mind-map node, inside a mode someone had opted into. `P` is
 * also Excalidraw's own native, unmodified shortcut for the freedraw
 * tool -- ambient pin runs on every board, for every selection, all the
 * time, so a keydown listener ahead of Excalidraw's own (this fork's
 * chrome sits in a DOM ancestor of Excalidraw's root, so bubbling always
 * reaches it first) would have silently eaten that native shortcut
 * everywhere, not just inside a mind map. `useAmbientPinKey.ts` (deleted)
 * had exactly this bug. The floating toolbar has no such collision: it
 * only reacts to a click on its own button.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
} from "../integrations/excalidraw/capabilities";
import { useExcalidrawRoot } from "../pages/editor/useExcalidrawRoot";
import { ElementFloatingToolbar } from "../pages/editor/ElementFloatingToolbar";
import { AmbientNodeOverlay } from "../ambientTree/AmbientNodeOverlay";
import { useAmbientNodeToolbar } from "../ambientTree/useAmbientNodeToolbar";
import { useAmbientOverlayState } from "../ambientTree/useAmbientOverlayState";
import { MindMapImportDialog } from "./MindMapImportDialog";
import { useMindMapImport } from "./useMindMapImport";
import { arrangeOps } from "./mindMapScene";
import type { ParseResult } from "./outlineParser";

const TOOLBAR_BUTTON_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: "100%",
  padding: "0 12px",
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

type Options = {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  interaction: Pick<InteractionCapability, "read">;
  scene: SceneCapability;
  selection: SelectionCapability;
  viewport: ViewportCapability;
};

export function useMindMapFeature({
  containerRef,
  canEdit,
  interaction,
  scene,
  selection,
  viewport,
}: Options) {
  const { isOpen, open, close, runImport } = useMindMapImport({ canEdit, scene, viewport });
  const excalidrawRoot = useExcalidrawRoot(containerRef);
  const {
    onSceneChange: onAmbientNodeToolbarSceneChange,
    toolbar,
    togglePin,
    toggleCollapse,
  } = useAmbientNodeToolbar({ canEdit, excalidrawRoot, interaction, scene, selection, viewport });
  // Separate from the toolbar hook above on purpose (NIL-598): the toolbar
  // only ever needs to redraw for what the LOCAL selection is doing, but
  // masks/badges must redraw for what ANY collaborator's collapse/pin just
  // did, whether or not it changed this client's own selection -- see
  // `useAmbientOverlayState.ts`'s own header for the measured bug this
  // fixes.
  const { state: overlayState, onSceneChange: onAmbientOverlaySceneChange } =
    useAmbientOverlayState({ container: excalidrawRoot, scene, viewport });

  const onOpenMindMapImport = useCallback(() => open(), [open]);

  const handleImport = useCallback(
    (result: Extract<ParseResult, { ok: true }>) => {
      const succeeded = runImport(result.root);
      if (!succeeded) toast.error("Couldn't import the mind map. Please try again.");
    },
    [runImport],
  );

  /**
   * Arrange the ambient subtree rooted at the current single selection.
   * Unlike v1 (which could fall back to "the board's only map" with
   * nothing selected), there is no single right answer for "which subtree"
   * on a board that may have several disconnected trees -- a selection is
   * required.
   */
  const onArrangeMindMap = useCallback(() => {
    if (!canEdit) return;
    const selected = selection.read();
    if (!selected.ok || selected.value.selectedIds.length !== 1) {
      toast.error("Select a node to arrange its tree from.");
      return;
    }
    const summaries = scene.summaries();
    if (!summaries.ok) return;

    const ops = arrangeOps(summaries.value, selected.value.selectedIds[0]);
    if (!ops) {
      toast.error("Nothing to arrange from here -- no qualifying children, or a cycle.");
      return;
    }
    if (ops.length === 0) return;
    const applied = scene.apply(ops);
    if (!applied.ok) toast.error("Couldn't arrange the tree. Please try again.");
  }, [canEdit, scene, selection]);

  const mindMapOverlay = (
    <>
      <MindMapImportDialog isOpen={isOpen} onClose={close} onImport={handleImport} />
      <AmbientNodeOverlay
        container={excalidrawRoot}
        state={overlayState}
        onExpand={toggleCollapse}
      />
      <ElementFloatingToolbar target={toolbar?.target ?? null} label="Node actions">
        {toolbar ? (
          <>
            <button
              type="button"
              data-testid="mind-map-pin-button"
              // Same focus-preserving guard as Collapse below -- without
              // it, the very next Ctrl+Z silently fails to undo the pin.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => togglePin(toolbar.nodeId)}
              style={TOOLBAR_BUTTON_STYLE}
            >
              {toolbar.pinned ? "Unpin" : "Pin"}
            </button>
            {toolbar.canCollapse ? (
              <button
                type="button"
                data-testid="mind-map-collapse-button"
                // Without this, clicking the button moves DOM focus off
                // the canvas, and the very next Ctrl+Z silently fails to
                // undo the collapse -- the same fix v1's own
                // `mind-map-collapse.spec.ts` caught by a real browser
                // run, not any unit test (jsdom never models
                // focus-dependent history capture).
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggleCollapse(toolbar.nodeId)}
                style={TOOLBAR_BUTTON_STYLE}
              >
                Collapse
              </button>
            ) : null}
          </>
        ) : null}
      </ElementFloatingToolbar>
    </>
  );

  const onMindMapSceneChange = useCallback(() => {
    onAmbientNodeToolbarSceneChange();
    onAmbientOverlaySceneChange();
  }, [onAmbientNodeToolbarSceneChange, onAmbientOverlaySceneChange]);

  return {
    mindMapOverlay,
    onArrangeMindMap,
    onOpenMindMapImport,
    onAmbientNodeToolbarSceneChange: onMindMapSceneChange,
  };
}
