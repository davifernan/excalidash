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

/**
 * Excalidraw's own `laserPointerToolIcon` (components/icons.tsx), reproduced
 * here because the capability only exposes a toolbar slot to portal into, not
 * the icon itself. Keep this in sync with upstream's icon, not a redrawn
 * lookalike -- see the file comment above.
 */
const LaserIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden focusable="false">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      transform="rotate(90 10 10)"
    >
      <path
        clipRule="evenodd"
        d="m9.644 13.69 7.774-7.773a2.357 2.357 0 0 0-3.334-3.334l-7.773 7.774L8 12l1.643 1.69Z"
      />
      <path d="m13.25 3.417 3.333 3.333M10 10l2-2M5 15l3-3M2.156 17.894l1-1M5.453 19.029l-.144-1.407M2.377 11.887l.866 1.118M8.354 17.273l-1.194-.758M.953 14.652l1.408.13" />
    </g>
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
        <span className="ToolIcon__keybinding">K</span>
      </div>
    </label>,
    toolbar,
  );
};
