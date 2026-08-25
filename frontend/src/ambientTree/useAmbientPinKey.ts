/**
 * `P` pins or unpins the single selected shape (NIL-593, Schnitt 3) --
 * ambient over any shape, not "a mind-map node". A deliberate second
 * action, same as v1: dragging a node still just moves it; pinning is
 * whether that hand-set position survives the next explicit "Arrange" run.
 */
import { useEffect } from "react";
import { toast } from "sonner";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
} from "../integrations/excalidraw/capabilities";
import { togglePinOps } from "./nodeState";

type Options = {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  interaction: Pick<InteractionCapability, "read">;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
};

export function useAmbientPinKey({
  canEdit,
  containerRef,
  interaction,
  scene,
  selection,
}: Options) {
  useEffect(() => {
    if (!canEdit) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      const wantsPinToggle =
        event.key.toLowerCase() === "p" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey;
      if (!wantsPinToggle) return;

      const state = interaction.read();
      if (!state.ok || state.value.editingTextElementId) return;
      const selected = selection.read();
      if (!selected.ok || selected.value.selectedIds.length !== 1) return;
      const nodeId = selected.value.selectedIds[0];

      event.preventDefault();
      event.stopPropagation();

      const summaries = scene.summaries();
      if (!summaries.ok) return;
      const ops = togglePinOps(summaries.value, nodeId);
      if (!ops) return;
      const applied = scene.apply(ops, { capture: "immediate" });
      if (!applied.ok) toast.error("Couldn't pin the node. Please try again.");
    };

    const target = containerRef.current;
    if (!target) return;
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }, [canEdit, containerRef, interaction, scene, selection]);
}
