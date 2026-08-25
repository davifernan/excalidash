/**
 * The laser pointer as a real member of the main tool row.
 *
 * Excalidraw's collaboration mode must stay enabled for its Presence UI, but
 * that mode also renders a standalone laser island beyond Sticky Note. The
 * targeted rule in editorChrome.css hides only that native presentation. This
 * portal uses the already-centralised toolbar seam and the interaction
 * capability, so the retained control is appended directly after Sticky Note.
 * If Excalidraw changes that seam the button visibly disappears and the
 * compatibility diagnostics fire.
 */
import { useEffect, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import type { InteractionCapability } from "../../../integrations/excalidraw/capabilities";
import { useToolbarSlot } from "../../../integrations/excalidraw/useToolbarSlot";

const LaserIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden focusable="false">
    <path d="m4 16 8.4-8.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="m11.2 3.5 1.1-2m2.2 4.2 2.2-.6m-1 3.7 1.7 1.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path d="m3 17 2.8-.7-2.1-2.1z" fill="currentColor" />
  </svg>
);

export const LaserToolbarButton = ({
  containerRef,
  interaction,
}: {
  containerRef: React.RefObject<HTMLElement>;
  interaction: InteractionCapability;
}) => {
  const toolbar = useToolbarSlot(containerRef);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!toolbar) return;
    const initial = interaction.read();
    if (initial.ok) {
      setActive(
        initial.value.activeTool.type === "builtin" && initial.value.activeTool.name === "laser",
      );
    }
    return interaction.subscribe((state) =>
      setActive(state.activeTool.type === "builtin" && state.activeTool.name === "laser"),
    );
  }, [interaction, toolbar]);

  if (!toolbar) return null;

  return createPortal(
    <label
      className={`ToolIcon ToolIcon__LaserPointer ToolIcon_size_small${active ? " ToolIcon--selected" : ""}`}
      title="Laser pointer — K"
    >
      <input
        className="ToolIcon_type_checkbox"
        type="checkbox"
        name="laser-pointer"
        aria-label="Laser pointer"
        aria-keyshortcuts="K"
        data-testid="toolbar-LaserPointer"
        checked={active}
        onChange={() => interaction.setActiveTool({ type: "builtin", name: "laser" })}
      />
      <div className="ToolIcon__icon">
        <LaserIcon />
      </div>
    </label>,
    toolbar,
  );
};
