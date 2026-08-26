/**
 * The bubble you type into, pinned to your own pointer.
 *
 * Everyone else's messages are painted by Excalidraw beside their cursors, so
 * this only has to handle the one case Excalidraw knows nothing about: your own.
 * It follows the pointer through a direct style write rather than React state,
 * because a re-render per mouse move would be a re-render of the whole editor.
 */
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { stacking } from "../../integrations/excalidraw/stacking";
import { CURSOR_CHAT_MAX_LENGTH } from "./cursorChat";

type CursorChatComposerProps = {
  container: HTMLElement | null;
  draft: string | null;
  onType: (text: string) => void;
  onClose: () => void;
};

export const CursorChatComposer: React.FC<CursorChatComposerProps> = ({
  container,
  draft,
  onType,
  onClose,
}) => {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Remembered across openings: Enter can be pressed without moving the mouse
  // first, and a bubble that appears in the top-left corner points at nothing.
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (draft === null || !container) return;
    inputRef.current?.focus();

    const place = (clientX: number, clientY: number) => {
      const bubble = bubbleRef.current;
      if (!bubble) return;
      const box = container.getBoundingClientRect();
      // Below and right of the pointer, where a cursor label sits, so the
      // bubble never covers the thing being pointed at -- unless that would put
      // it past the edge, since the editor root clips and it would be lost.
      const width = bubble.offsetWidth || 220;
      const height = bubble.offsetHeight || 32;
      const x = Math.min(Math.max(clientX - box.left + 14, 8), Math.max(8, box.width - width - 8));
      const y = Math.min(Math.max(clientY - box.top + 18, 8), Math.max(8, box.height - height - 8));
      bubble.style.transform = `translate(${x}px, ${y}px)`;
    };

    const follow = (event: PointerEvent) => {
      lastPoint.current = { x: event.clientX, y: event.clientY };
      place(event.clientX, event.clientY);
    };

    const start = lastPoint.current;
    const box = container.getBoundingClientRect();
    place(start?.x ?? box.left + box.width / 2, start?.y ?? box.top + box.height / 2);

    container.addEventListener("pointermove", follow);
    return () => container.removeEventListener("pointermove", follow);
  }, [draft, container]);

  if (draft === null || !container) return null;

  return createPortal(
    <div
      ref={bubbleRef}
      data-testid="cursor-chat-composer"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        zIndex: stacking.anchoredOverlay,
        display: "flex",
        alignItems: "center",
        gap: "0.35rem",
        maxWidth: "22rem",
        padding: "0.25rem 0.5rem",
        borderRadius: "var(--border-radius-lg, 0.5rem)",
        background: "var(--island-bg-color, #fff)",
        boxShadow: "var(--shadow-island, 0 1px 4px rgba(0,0,0,.15))",
        color: "var(--text-primary-color, #1b1b1f)",
        font: "13px/1.3 var(--ui-font, inherit)",
      }}
    >
      <input
        ref={inputRef}
        value={draft}
        maxLength={CURSOR_CHAT_MAX_LENGTH}
        placeholder="Say something"
        aria-label="Cursor chat"
        onChange={(event) => onType(event.target.value)}
        onKeyDown={(event) => {
          // Both ways out say the same thing: it was for the moment, and the
          // moment is over. Nothing is kept either way.
          if (event.key === "Escape" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          // Excalidraw listens on the container; a keystroke meant for this box
          // must not also pick a tool.
          event.stopPropagation();
        }}
        onBlur={onClose}
        style={{
          width: "12rem",
          border: "none",
          outline: "none",
          background: "transparent",
          color: "inherit",
          font: "inherit",
        }}
      />
    </div>,
    container,
  );
};
