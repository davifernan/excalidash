/**
 * The mind-map feature, as one thing the editor page wires in (NIL-593,
 * Schnitt 2/3).
 *
 * Two explicit commands survive the mode teardown: "Import mind map..."
 * (paste an outline, preview, write once) and "Arrange" (lay out the
 * ambient subtree rooted at the current selection, respecting pinned
 * nodes). Pin (`P`) and collapse (the floating toolbar) are ambient over
 * ANY shape (Schnitt 3, `../ambientTree/nodeState.ts` and its
 * `useAmbientPinKey`/`useAmbientNodeToolbar` hooks) -- they are wired in
 * here rather than in `Editor.tsx` directly only because this is already
 * the file that owns the mind-map overlay slot, not because they are a
 * "mind map" concept; nothing in `ambientTree/` has ever heard of one.
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
import { useAmbientPinKey } from "../ambientTree/useAmbientPinKey";
import { MindMapImportDialog } from "./MindMapImportDialog";
import { useMindMapImport } from "./useMindMapImport";
import { arrangeOps } from "./mindMapScene";
import type { ParseResult } from "./outlineParser";

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
  useAmbientPinKey({ canEdit, containerRef, interaction, scene, selection });
  const {
    onSceneChange: onAmbientNodeToolbarSceneChange,
    toolbarTarget: ambientToolbarTarget,
    toggleCollapse,
  } = useAmbientNodeToolbar({ canEdit, excalidrawRoot, interaction, scene, selection, viewport });

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
        scene={scene}
        viewport={viewport}
        onExpand={toggleCollapse}
      />
      <ElementFloatingToolbar target={ambientToolbarTarget} label="Node actions">
        <button
          type="button"
          data-testid="mind-map-collapse-button"
          // Without this, clicking the button moves DOM focus off the
          // canvas, and the very next Ctrl+Z silently fails to undo the
          // collapse -- the same fix v1's own `mind-map-collapse.spec.ts`
          // caught by a real browser run, not any unit test (jsdom never
          // models focus-dependent history capture).
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const selected = selection.read();
            if (selected.ok && selected.value.selectedIds.length === 1) {
              toggleCollapse(selected.value.selectedIds[0]);
            }
          }}
          style={{
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
          }}
        >
          Collapse
        </button>
      </ElementFloatingToolbar>
    </>
  );

  return { mindMapOverlay, onArrangeMindMap, onOpenMindMapImport, onAmbientNodeToolbarSceneChange };
}
