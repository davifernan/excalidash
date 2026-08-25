/**
 * The note tool, sitting in Excalidraw's own toolbar.
 *
 * Excalidraw builds that toolbar from a fixed list and offers no way to add to
 * it, so the button is portalled into the rendered element instead. That is a
 * dependency on markup rather than on API, and it is taken knowingly: a button
 * beside the other tools is where people look for a tool, and the top-right
 * corner is where they look for a menu.
 *
 * The risk is contained by what happens when it breaks. React only patches the
 * children it created, so an appended node is left alone; if a future version
 * renames the toolbar, the portal finds nothing and the button is simply
 * absent — visible immediately, and caught by a browser test. Nothing silently
 * changes behaviour.
 *
 * The markup mirrors Excalidraw's own ToolButton so the button inherits the
 * toolbar's styling instead of approximating it.
 */
import React from "react";
import { createPortal } from "react-dom";
import { useToolbarSlot } from "../integrations/excalidraw/useToolbarSlot";
import { STICKY_SHORTCUT, type StickyColor } from "./stickyNote";

const NoteIcon = ({ color }: { color: StickyColor }) => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden focusable="false">
    <path
      d="M3 3h14v9.5L12.5 17H3z"
      fill={color.fill}
      stroke={color.ink}
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path
      d="M17 12.5h-4.5V17"
      fill="none"
      stroke={color.ink}
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

type Props = {
  containerRef: React.RefObject<HTMLElement>;
  armed: boolean;
  color: StickyColor;
  onArm: () => void;
};

export const StickyToolbarButton: React.FC<Props> = ({ containerRef, armed, color, onArm }) => {
  const toolbar = useToolbarSlot(containerRef);
  if (!toolbar) return null;

  return createPortal(
    <label
      className={`ToolIcon Shape${armed ? " ToolIcon--selected" : ""}`}
      title={`Sticky note — ${STICKY_SHORTCUT.toUpperCase()}`}
      data-testid="toolbar-sticky"
    >
      <input
        className="ToolIcon_type_radio ToolIcon_size_medium"
        type="radio"
        name="editor-current-shape"
        aria-label="Sticky note"
        aria-keyshortcuts={STICKY_SHORTCUT}
        checked={armed}
        onChange={onArm}
      />
      <div className="ToolIcon__icon">
        <NoteIcon color={color} />
        <span className="ToolIcon__keybinding">{STICKY_SHORTCUT.toUpperCase()}</span>
      </div>
    </label>,
    toolbar,
  );
};
