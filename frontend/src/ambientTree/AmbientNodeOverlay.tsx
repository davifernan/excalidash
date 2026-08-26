/**
 * What pinned and collapsed look like, ambient over any node (NIL-593,
 * Schnitt 3): a mask over every element a collapse hides, a count badge on
 * the collapsed node itself that also un-collapses it on click (NIL-587's
 * own two adopted points, carried over from the deleted v1
 * `MindMapCollapseOverlay.tsx`: "the number is the only way to tell a
 * collapsed branch from a leaf" and "the number is itself the expand
 * control"), and a small pin badge on a pinned node.
 *
 * Deliberately does NOT recolor a pinned node's own `strokeColor` the way
 * v1 did (`MIND_MAP_COLORS.pinnedStroke`, unconditionally overwriting
 * whatever stroke the node already had). v1 could get away with that
 * because every node it ever touched was one of its own auto-generated
 * rectangles with a fixed default stroke. Pin is ambient now -- it can land
 * on any hand-drawn shape with a colour the person chose on purpose, and
 * silently overwriting that on pin/unpin would be a real, surprising data
 * loss for a completely unrelated reason. A badge is non-destructive: it
 * reads state, never writes appearance.
 *
 * Purely a rendering layer, exactly `MindMapDropHighlight.tsx`'s and
 * `MindMapCollapseOverlay.tsx`'s own shape: every mask and badge is
 * computed fresh from the live scene and viewport on each render, nothing
 * here is an Excalidraw element or gets written back to the scene, and
 * collapsing an element never touches the elements it hides (see
 * `collapsedHiddenIds` in `nodeState.ts`).
 *
 * Known limitation, unchanged from v1: the mask's `pointerEvents: "none"`
 * keeps canvas panning and zooming working underneath it, but also means a
 * hidden element is still directly clickable/draggable if a person's
 * pointer lands exactly on it -- this slice does not attempt to block that.
 */
import React from "react";
import { createPortal } from "react-dom";
import { Pin } from "lucide-react";
import type { SceneCapability, ViewportCapability } from "../integrations/excalidraw/capabilities";
import { elementViewportBounds } from "../pages/editor/floatingToolbarGeometry";
import { collapsedHiddenIds, collapsedNodeIds, pinnedNodeIds } from "./nodeState";

const BADGE_COLOR = "#868e96"; // same token as ambient edges (`IMPORT_COLORS.edgeStroke`)
const PIN_COLOR = "#f76707"; // same open-color orange-7 v1 used for its pinned stroke

type Props = {
  container: HTMLElement | null;
  scene: Pick<SceneCapability, "summaries">;
  viewport: Pick<ViewportCapability, "read">;
  onExpand: (nodeId: string) => void;
};

export const AmbientNodeOverlay: React.FC<Props> = ({ container, scene, viewport, onExpand }) => {
  if (!container) return null;

  const summaries = scene.summaries();
  const viewportState = viewport.read();
  if (!summaries.ok || !viewportState.ok) return null;

  const byId = new Map(summaries.value.map((element) => [element.id, element] as const));
  const hostRect = container.getBoundingClientRect();
  const nodes: React.ReactNode[] = [];

  const collapsedIds = collapsedNodeIds(summaries.value);
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
          key={`ambient-collapse-mask-${hiddenId}`}
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
        key={`ambient-collapse-badge-${nodeId}`}
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
          background: BADGE_COLOR,
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

  for (const nodeId of pinnedNodeIds(summaries.value)) {
    const nodeSummary = byId.get(nodeId as never);
    if (!nodeSummary) continue;
    const bounds = elementViewportBounds(nodeSummary, viewportState.value);
    nodes.push(
      <div
        key={`ambient-pin-badge-${nodeId}`}
        data-testid="mind-map-pin-badge"
        aria-hidden
        style={{
          position: "absolute",
          left: bounds.left - hostRect.left - 8,
          top: bounds.top - hostRect.top - 8,
          width: 20,
          height: 20,
          borderRadius: "50%",
          border: `1px solid var(--default-border-color, rgb(0 0 0 / 10%))`,
          background: PIN_COLOR,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 4,
        }}
      >
        <Pin size={12} fill="#fff" />
      </div>,
    );
  }

  return createPortal(<>{nodes}</>, container);
};
