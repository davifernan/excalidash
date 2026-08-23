/**
 * Keeping Excalidraw's text hint away from sticky notes.
 *
 * The editor is told through an attribute on the container rather than by
 * reaching into its DOM: the stylesheet next door reads that attribute, so the
 * worst that a renamed hint element can do is leave the hint showing, which is
 * where it started.
 */
import { useEffect } from "react";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
} from "../integrations/excalidraw/capabilities";
import { isStickyNote } from "./stickyNote";
import "./stickyHint.css";

/** True when the only thing selected, or being typed into, is a note. */
function stickyIsTheSelection({
  interaction,
  scene,
  selection,
}: {
  interaction: Pick<InteractionCapability, "read">;
  scene: Pick<SceneCapability, "summaryById">;
  selection: Pick<SelectionCapability, "read">;
}): boolean {
  const state = interaction.read();
  if (!state.ok) return false;

  const editingId = state.value.editingTextContainerId;
  if (editingId) {
    const editing = scene.summaryById(editingId);
    return editing.ok && isStickyNote(editing.value);
  }

  const selectedState = selection.read();
  if (!selectedState.ok || selectedState.value.selectedIds.length !== 1) return false;
  const selected = scene.summaryById(selectedState.value.selectedIds[0]);
  return selected.ok && isStickyNote(selected.value);
}

export function useStickyHint({
  containerRef,
  canEdit,
  interaction,
  ready,
  scene,
  selection,
}: {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  interaction: Pick<InteractionCapability, "read">;
  scene: Pick<SceneCapability, "subscribe" | "summaryById">;
  selection: Pick<SelectionCapability, "read">;
  /**
   * Whether the editor has handed over its API yet.
   *
   * Without it this effect would run once on mount, find nothing to subscribe
   * to and never try again — a mistake this code has made twice before, both
   * times silently.
   */
  ready: boolean;
}) {
  useEffect(() => {
    const container = containerRef.current;
    if (!ready || !container || !canEdit) return;

    const update = () => {
      const on = stickyIsTheSelection({ interaction, scene, selection });
      if (on) container.dataset.stickySelection = "true";
      else delete container.dataset.stickySelection;
    };

    update();
    const stop = scene.subscribe(update);
    return () => {
      stop?.();
      delete container.dataset.stickySelection;
    };
  }, [canEdit, containerRef, interaction, ready, scene, selection]);
}
