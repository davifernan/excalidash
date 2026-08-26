/**
 * The two explicit mind-map commands that remain after the mode teardown:
 * import an outline and arrange the ambient tree rooted at the selection.
 *
 * NIL-606 removed the generic element toolbar again. Its only actions were
 * Pin and Collapse, so rendering an empty toolbar until NIL-610 supplies
 * useful element-aware actions would leave dead chrome on every selection.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import type {
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
} from "../integrations/excalidraw/capabilities";
import { MindMapImportDialog } from "./MindMapImportDialog";
import { useMindMapImport } from "./useMindMapImport";
import { arrangeOps } from "./mindMapScene";
import type { ParseResult } from "./outlineParser";

type Options = {
  canEdit: boolean;
  scene: SceneCapability;
  selection: SelectionCapability;
  viewport: ViewportCapability;
};

export function useMindMapFeature({ canEdit, scene, selection, viewport }: Options) {
  const { isOpen, open, close, runImport } = useMindMapImport({ canEdit, scene, viewport });

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
    <MindMapImportDialog isOpen={isOpen} onClose={close} onImport={handleImport} />
  );

  return {
    mindMapOverlay,
    onArrangeMindMap,
    onOpenMindMapImport,
  };
}
