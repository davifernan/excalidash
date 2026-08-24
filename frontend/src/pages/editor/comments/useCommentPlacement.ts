import { useCallback, useEffect, useState } from "react";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
} from "../../../integrations/excalidraw/capabilities";
import type { ThreadDraftAnchor } from "./useComments";

type UseCommentPlacementInput = {
  interaction: InteractionCapability;
  selection: SelectionCapability;
  scene: SceneCapability;
  onCapabilityFailure: (seam: string) => void;
};

/**
 * "Comment on a point": arm placement mode, take the next canvas pointer-down
 * as the anchor, hit-test it through the adapter (the only hit-testing this
 * product has -- Excalidraw offers none publicly, NIL-227/NIL-283) and hand
 * the caller a draft anchor. No bespoke DOM listener: `interaction.onPointerDown`
 * already gives a scene point, which is what selection.anchorAt needs.
 */
export const useCommentPlacement = ({
  interaction,
  selection,
  scene,
  onCapabilityFailure,
}: UseCommentPlacementInput) => {
  const [isPlacing, setIsPlacing] = useState(false);
  const [draftAnchor, setDraftAnchor] = useState<ThreadDraftAnchor | null>(null);

  useEffect(() => {
    if (!isPlacing) return;
    return interaction.onPointerDown((point) => {
      setIsPlacing(false);
      const hit = selection.anchorAt(point);
      if (!hit.ok) {
        onCapabilityFailure(hit.seam);
        setDraftAnchor({ elementId: null, x: point.x, y: point.y });
        return;
      }
      setDraftAnchor({ elementId: hit.value, x: point.x, y: point.y });
    });
  }, [isPlacing, interaction, selection, onCapabilityFailure]);

  const beginPlacing = useCallback(() => setIsPlacing(true), []);
  const cancelPlacing = useCallback(() => setIsPlacing(false), []);
  const clearDraftAnchor = useCallback(() => setDraftAnchor(null), []);

  /** Anchor the next thread to whatever is selected right now, no click needed. */
  const useSelectionAsAnchor = useCallback(() => {
    const selected = selection.read();
    if (!selected.ok) {
      onCapabilityFailure(selected.seam);
      return;
    }
    const [elementId] = selected.value.selectedIds;
    if (!elementId) return;
    const summary = scene.summaryById(elementId);
    const point =
      summary.ok && summary.value ? { x: summary.value.x, y: summary.value.y } : { x: 0, y: 0 };
    setDraftAnchor({ elementId, ...point });
  }, [selection, scene, onCapabilityFailure]);

  return {
    isPlacing,
    beginPlacing,
    cancelPlacing,
    draftAnchor,
    clearDraftAnchor,
    useSelectionAsAnchor,
  };
};
