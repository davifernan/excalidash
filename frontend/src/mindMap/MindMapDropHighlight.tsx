/**
 * The drop-target preview for drag-to-reparent (NIL-571): a highlighted
 * outline around whichever node the dragged node would reparent onto if
 * released right now, visible *before* the drop -- the ticket's own
 * acceptance line ("Drop-Ziel und resultierende Position sind vor dem
 * Loslassen sichtbar").
 *
 * Portalled into `ui.overlayRoot()` like every other mind-map/sticky
 * overlay, positioned from the target's own `ElementSummary` box through
 * `elementViewportBounds` -- the same viewport-projection helper the
 * asset-widget toolbar already uses for the same "scene box to screen
 * rectangle" conversion (`floatingToolbarGeometry.ts`).
 */
import React from "react";
import { createPortal } from "react-dom";
import type { SceneCapability, ViewportCapability } from "../integrations/excalidraw/capabilities";
import { elementViewportBounds } from "../pages/editor/floatingToolbarGeometry";
import { MIND_MAP_COLORS } from "./mindMapElements";
import type { MindMapDragPreview } from "./useMindMapDrag";

type Props = {
  container: HTMLElement | null;
  preview: MindMapDragPreview | null;
  scene: Pick<SceneCapability, "summaryById">;
  viewport: Pick<ViewportCapability, "read">;
};

export const MindMapDropHighlight: React.FC<Props> = ({ container, preview, scene, viewport }) => {
  if (!container || !preview?.targetId) return null;

  const target = scene.summaryById(preview.targetId as never);
  const viewportState = viewport.read();
  if (!target.ok || !target.value || !viewportState.ok) return null;

  const bounds = elementViewportBounds(target.value, viewportState.value);
  const hostRect = container.getBoundingClientRect();
  const left = bounds.left - hostRect.left;
  const top = bounds.top - hostRect.top;

  return createPortal(
    <div
      data-testid="mind-map-drop-highlight"
      data-target-id={preview.targetId}
      aria-hidden
      style={{
        position: "absolute",
        left: left - 4,
        top: top - 4,
        width: bounds.right - bounds.left + 8,
        height: bounds.bottom - bounds.top + 8,
        border: `2px solid ${MIND_MAP_COLORS.dropHighlight}`,
        borderRadius: 10,
        pointerEvents: "none",
        zIndex: 3,
      }}
    />,
    container,
  );
};
