/**
 * The note that is not there yet.
 *
 * With the tool in hand, a faint note follows the pointer showing exactly where
 * and how big the real one will land. Miro does this, and the reason it helps
 * is not decoration: a note is placed by its centre, and without something to
 * look at nobody can tell whether the click point is the middle or a corner
 * until the note appears in the wrong place.
 *
 * It follows the pointer directly rather than through React state per move —
 * a re-render on every mouse position would be the same mistake that once
 * drove the editor into an infinite loop, only quieter.
 */
import React, { useEffect, useRef } from "react";
import type { ViewportCapability } from "../integrations/excalidraw/capabilities";
import { stacking } from "../integrations/excalidraw/stacking";
import { STICKY_SIZE, type StickyColor } from "./stickyNote";

/**
 * Faint enough to read the board through, solid enough to judge where the note
 * will sit and what colour it will be.
 */
const GHOST_OPACITY = "0.45";

type Props = {
  containerRef: React.RefObject<HTMLElement>;
  color: StickyColor;
  viewport: Pick<ViewportCapability, "read">;
};

export const StickyPreview: React.FC<Props> = ({ containerRef, color, viewport }) => {
  const ghost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const node = ghost.current;
    if (!container || !node) return;

    const place = (event: PointerEvent) => {
      const state = viewport.read();
      // Before the editor attaches, the preview has always used an unzoomed
      // note. Keep that harmless fallback while the capability reports why.
      const zoom = state.ok ? state.value.zoom : 1;
      const rect = container.getBoundingClientRect();
      // Scaled with the canvas, so the ghost is the size the note will be —
      // which is the whole point of showing it.
      const side = STICKY_SIZE * zoom;
      node.style.width = `${side}px`;
      node.style.height = `${side}px`;
      node.style.transform = `translate(${event.clientX - rect.left - side / 2}px, ${
        event.clientY - rect.top - side / 2
      }px)`;
      node.style.opacity = GHOST_OPACITY;
    };

    // Hidden until the pointer is actually over the board, so it does not sit
    // in the corner where it was last seen.
    const hide = () => {
      node.style.opacity = "0";
    };

    container.addEventListener("pointermove", place);
    container.addEventListener("pointerleave", hide);
    return () => {
      container.removeEventListener("pointermove", place);
      container.removeEventListener("pointerleave", hide);
    };
  }, [containerRef, viewport]);

  return (
    <div
      ref={ghost}
      aria-hidden
      data-testid="sticky-preview"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: STICKY_SIZE,
        height: STICKY_SIZE,
        backgroundColor: color.fill,
        border: `1px solid ${color.edge}`,
        opacity: 0,
        pointerEvents: "none",
        zIndex: stacking.elementOverlay,
        willChange: "transform",
      }}
    />
  );
};
