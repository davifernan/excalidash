/**
 * The one key cursor chat needs, claimed as carefully as possible.
 *
 * The listener sits in the capture phase, ahead of Excalidraw's own shortcut
 * handling, because otherwise the key is gone before we see it. It hands the
 * key straight back in every case where it is not ours -- see
 * shouldOpenCursorChat for what those are and why.
 */
import { useEffect } from "react";
import type React from "react";
import type { SelectionCapability } from "../../integrations/excalidraw/capabilities";
import { shouldOpenCursorChat, type CursorChatController } from "./cursorChat";

export const useCursorChatKey = ({
  containerRef,
  enabled,
  selection,
  chatRef,
}: {
  containerRef: React.RefObject<HTMLElement>;
  enabled: boolean;
  selection: SelectionCapability;
  chatRef: { current: CursorChatController | null };
}) => {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Asked at the moment of the keystroke rather than captured in a render:
      // with something selected Enter is Excalidraw's, and that is also how a
      // freshly placed sticky note gets its label editor.
      const currentSelection = selection.read();
      // A missing selection seam has the same fallback as an unattached raw
      // handle did: treat the canvas as idle. The capability has already sent
      // the structured failure to compatibility diagnostics.
      const hasSelection = currentSelection.ok
        ? currentSelection.value.selectedIds.length > 0
        : false;
      if (!shouldOpenCursorChat(event, { hasSelection })) return;
      event.preventDefault();
      event.stopPropagation();
      chatRef.current?.open();
    };

    container.addEventListener("keydown", onKeyDown, true);
    return () => container.removeEventListener("keydown", onKeyDown, true);
  }, [chatRef, containerRef, enabled, selection]);
};
