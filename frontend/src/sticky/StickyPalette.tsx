/**
 * The six colours, under the toolbar.
 *
 * Shown only while the note tool is armed, the way Excalidraw shows a tool's
 * options only while that tool is in use. It is anchored to the toolbar rather
 * than placed at a fixed spot, because the toolbar moves: it centres itself on
 * the canvas and changes shape on a narrow screen.
 */
import React, { useEffect, useState } from "react";

import { findToolbarIsland } from "../integrations/excalidraw/domBridge";
import { createPortal } from "react-dom";
import { STICKY_COLORS, type StickyColor } from "./stickyNote";

type Props = {
  toolbar: HTMLElement | null;
  color: StickyColor;
  onPick: (color: StickyColor) => void;
};

/** Where to sit, in the coordinates of the toolbar's offset parent. */
function useAnchor(toolbar: HTMLElement | null) {
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!toolbar) {
      setBox(null);
      return;
    }
    const measure = () => {
      // Measured from the toolbar's outer box so the colours clear the whole
      // island rather than overlapping its lower edge.
      const found = findToolbarIsland(toolbar);
      const island = found.ok ? found.value : toolbar;
      const rect = island.getBoundingClientRect();
      const parent = (toolbar.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      setBox({
        top: rect.bottom - (parent?.top ?? 0) + 8,
        left: rect.left + rect.width / 2 - (parent?.left ?? 0),
      });
    };
    measure();
    // The toolbar recentres on every window resize.
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [toolbar]);

  return box;
}

const Swatch = ({ color }: { color: StickyColor }) => (
  <span
    aria-hidden
    style={{
      width: 16,
      height: 16,
      backgroundColor: color.fill,
      border: `1px solid ${color.edge}`,
      borderRadius: 2,
      display: "block",
    }}
  />
);

export const StickyPalette: React.FC<Props> = ({ toolbar, color, onPick }) => {
  const anchor = useAnchor(toolbar);
  const host = toolbar?.offsetParent ?? null;
  if (!anchor || !host) return null;

  return createPortal(
    <div
      role="group"
      aria-label="Note colour"
      className="flex gap-1 p-1.5 bg-white dark:bg-neutral-800"
      style={{
        position: "absolute",
        top: anchor.top,
        left: anchor.left,
        transform: "translateX(-50%)",
        borderRadius: 10,
        boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 2px 6px rgba(0,0,0,0.08)",
        zIndex: 5,
      }}
    >
      {STICKY_COLORS.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onPick(option)}
          aria-pressed={option.id === color.id}
          title={option.label}
          className={`h-6 w-6 flex items-center justify-center rounded transition-transform ${
            option.id === color.id
              ? "outline outline-2 outline-indigo-500 dark:outline-indigo-400"
              : "hover:scale-110"
          }`}
        >
          <Swatch color={option} />
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>,
    host as Element,
  );
};
