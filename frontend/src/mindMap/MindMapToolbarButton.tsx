/**
 * The Mind Map tool, sitting in Excalidraw's own toolbar -- see
 * `../sticky/StickyToolbarButton.tsx`'s file comment for why this is a
 * portal into the toolbar island rather than a capability call, and why that
 * is a knowingly-taken, visibly-failing-shut risk.
 */
import React from "react";
import { createPortal } from "react-dom";
import { useToolbarSlot } from "../integrations/excalidraw/useToolbarSlot";
import { MIND_MAP_SHORTCUT } from "./useMindMapTool";

const MindMapIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden focusable="false">
    <rect
      x="1"
      y="7"
      width="6"
      height="6"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <rect
      x="13"
      y="1"
      width="6"
      height="5"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <rect
      x="13"
      y="13"
      width="6"
      height="6"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path d="M7 9h3v-5.5h3" fill="none" stroke="currentColor" strokeWidth="1.1" />
    <path d="M7 11h3v5h3" fill="none" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

type Props = {
  containerRef: React.RefObject<HTMLElement>;
  armed: boolean;
  onArm: () => void;
};

export const MindMapToolbarButton: React.FC<Props> = ({ containerRef, armed, onArm }) => {
  const toolbar = useToolbarSlot(containerRef);
  if (!toolbar) return null;

  return createPortal(
    <label
      className={`ToolIcon Shape${armed ? " ToolIcon--selected" : ""}`}
      title={`Mind Map — ${MIND_MAP_SHORTCUT.toUpperCase()}`}
      data-testid="toolbar-mind-map"
    >
      <input
        className="ToolIcon_type_radio ToolIcon_size_medium"
        type="radio"
        name="editor-current-shape"
        aria-label="Mind Map"
        aria-keyshortcuts={MIND_MAP_SHORTCUT}
        checked={armed}
        onChange={onArm}
      />
      <div className="ToolIcon__icon">
        <MindMapIcon />
        <span className="ToolIcon__keybinding">{MIND_MAP_SHORTCUT.toUpperCase()}</span>
      </div>
    </label>,
    toolbar,
  );
};
