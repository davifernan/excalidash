/**
 * Keeping Excalidraw's text hint away from sticky notes.
 *
 * The editor is told through an attribute on the container rather than by
 * reaching into its DOM: the stylesheet next door reads that attribute, so the
 * worst that a renamed hint element can do is leave the hint showing, which is
 * where it started.
 */
import { useCallback, useEffect } from "react";
import { createExcalidrawAdapter, type ExcalidrawAdapter } from "../integrations/excalidraw";
import { isStickyNote } from "./stickyNote";
import "./stickyHint.css";

/** True when the only thing selected, or being typed into, is a note. */
function stickyIsTheSelection(adapter: ExcalidrawAdapter): boolean {
  const interaction = adapter.interaction.read();
  if (!interaction.ok) return false;

  const editingId = interaction.value.editingTextContainerId;
  if (editingId) {
    const editing = adapter.scene.summaryById(editingId);
    return editing.ok && isStickyNote(editing.value);
  }

  const selection = adapter.selection.read();
  if (!selection.ok || selection.value.selectedIds.length !== 1) return false;
  const selected = adapter.scene.summaryById(selection.value.selectedIds[0]);
  return selected.ok && isStickyNote(selected.value);
}

export function useStickyHint({
  excalidrawAPI,
  containerRef,
  canEdit,
  ready,
}: {
  excalidrawAPI: { current: any };
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  /**
   * Whether the editor has handed over its API yet.
   *
   * Without it this effect would run once on mount, find nothing to subscribe
   * to and never try again — a mistake this code has made twice before, both
   * times silently.
   */
  ready: boolean;
}) {
  const getAdapter = useCallback(
    () =>
      createExcalidrawAdapter({
        api: () => excalidrawAPI.current,
        container: () => containerRef.current,
        canEdit: () => canEdit,
      }),
    [canEdit, containerRef, excalidrawAPI],
  );

  useEffect(() => {
    const adapter = getAdapter();
    const container = containerRef.current;
    if (!ready || !container || !canEdit) return;

    const update = () => {
      const on = stickyIsTheSelection(adapter);
      if (on) container.dataset.stickySelection = "true";
      else delete container.dataset.stickySelection;
    };

    update();
    const stop = adapter.scene.subscribe(update);
    return () => {
      stop?.();
      delete container.dataset.stickySelection;
    };
  }, [canEdit, containerRef, getAdapter, ready]);
}
