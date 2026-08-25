/**
 * What a collapsed branch looks like (NIL-571 v2): a mask over every hidden
 * descendant, and a count badge on the collapsed node itself that also
 * un-collapses it on click -- NIL-587's own two adopted points ("the number
 * is the only way to tell a collapsed branch from a leaf" and "the number
 * is itself the expand control").
 *
 * Purely a rendering layer: every mask and badge is computed fresh from the
 * live scene and viewport on each render, exactly the way
 * `MindMapDropHighlight.tsx` already does for the drop-target preview.
 * Nothing here is an Excalidraw element or gets written back to the scene
 * -- collapsing an element never touches the elements it hides (see
 * `collapsedHiddenIds` in `mindMapScene.ts`).
 *
 * Known limitation: the mask's `pointerEvents: "none"` keeps canvas panning
 * and zooming working underneath it, but also means a hidden element is
 * still directly clickable/draggable if a person's pointer lands exactly on
 * it -- this slice does not attempt to block that.
 */
import React from "react";
import { createPortal } from "react-dom";
import type { SceneCapability, ViewportCapability } from "../integrations/excalidraw/capabilities";
import { elementViewportBounds } from "../pages/editor/floatingToolbarGeometry";
import { MIND_MAP_COLORS } from "./mindMapElements";
import { collapsedHiddenIds, collapsedNodeIds } from "./mindMapScene";

type Props = {
  container: HTMLElement | null;
  scene: Pick<SceneCapability, "summaries">;
  viewport: Pick<ViewportCapability, "read">;
  onExpand: (nodeId: string) => void;
};

export const MindMapCollapseOverlay: React.FC<Props> = ({
  container,
  scene,
  viewport,
  onExpand,
}) => {
  if (!container) return null;

  const summaries = scene.summaries();
  const viewportState = viewport.read();
  if (!summaries.ok || !viewportState.ok) return null;

  const collapsedIds = collapsedNodeIds(summaries.value);
  if (collapsedIds.size === 0) return null;

  const byId = new Map(summaries.value.map((element) => [element.id, element] as const));
  const hostRect = container.getBoundingClientRect();
  const nodes: React.ReactNode[] = [];

  for (const nodeId of collapsedIds) {
    const hidden = collapsedHiddenIds(summaries.value, nodeId);
    const nodeSummary = byId.get(nodeId as never);
    if (!hidden || !nodeSummary) continue; // stale flag on a leaf, or the node itself is gone

    for (const hiddenId of hidden.ids) {
      const element = byId.get(hiddenId as never);
      if (!element) continue;
      const bounds = elementViewportBounds(element, viewportState.value);
      nodes.push(
        <div
          key={`mind-map-collapse-mask-${hiddenId}`}
          data-testid="mind-map-collapse-mask"
          aria-hidden
          style={{
            position: "absolute",
            left: bounds.left - hostRect.left,
            top: bounds.top - hostRect.top,
            width: bounds.right - bounds.left,
            height: bounds.bottom - bounds.top,
            background: "var(--island-bg-color, #fff)",
            pointerEvents: "none",
            zIndex: 2,
          }}
        />,
      );
    }

    const nodeBounds = elementViewportBounds(nodeSummary, viewportState.value);
    nodes.push(
      <button
        key={`mind-map-collapse-badge-${nodeId}`}
        type="button"
        data-testid="mind-map-collapse-badge"
        data-node-id={nodeId}
        aria-label={`Expand ${hidden.nodeCount} hidden node${hidden.nodeCount === 1 ? "" : "s"}`}
        onClick={() => onExpand(nodeId)}
        style={{
          position: "absolute",
          left: nodeBounds.right - hostRect.left - 20,
          top: nodeBounds.bottom - hostRect.top - 14,
          minWidth: 24,
          height: 24,
          padding: "0 6px",
          borderRadius: 12,
          border: `1px solid var(--default-border-color, rgb(0 0 0 / 10%))`,
          background: MIND_MAP_COLORS.edgeStroke,
          color: "#fff",
          fontSize: 12,
          fontFamily: "system-ui, sans-serif",
          lineHeight: "22px",
          textAlign: "center",
          cursor: "pointer",
          pointerEvents: "auto",
          zIndex: 4,
        }}
      >
        {hidden.nodeCount}
      </button>,
    );
  }

  return createPortal(<>{nodes}</>, container);
};
