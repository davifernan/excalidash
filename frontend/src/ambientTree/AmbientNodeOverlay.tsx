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
 * A PURE renderer of `useAmbientOverlayState.ts`'s own computed render data
 * (NIL-598) -- it no longer reads the scene or viewport itself. That used
 * to seem safe ("computed fresh from the live scene on each render", same
 * shape as `MindMapDropHighlight.tsx`), but "each render" only happens if
 * something actually re-renders the owning component, which is not
 * guaranteed on a client that never locally changes selection (see
 * `useAmbientOverlayState.ts`'s own header for the measured bug and the
 * fix). Nothing here is an Excalidraw element or gets written back to the
 * scene, and collapsing an element never touches the elements it hides (see
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
import type { AmbientOverlayState } from "./useAmbientOverlayState";

const BADGE_COLOR = "#868e96"; // same token as ambient edges (`IMPORT_COLORS.edgeStroke`)
const PIN_COLOR = "#f76707"; // same open-color orange-7 v1 used for its pinned stroke

type Props = {
  container: HTMLElement | null;
  state: AmbientOverlayState;
  onExpand: (nodeId: string) => void;
};

export const AmbientNodeOverlay: React.FC<Props> = ({ container, state, onExpand }) => {
  if (!container) return null;

  const nodes: React.ReactNode[] = [];

  for (const mask of state.masks) {
    nodes.push(
      <div
        key={`ambient-collapse-mask-${mask.id}`}
        data-testid="mind-map-collapse-mask"
        aria-hidden
        style={{
          position: "absolute",
          left: mask.left,
          top: mask.top,
          width: mask.width,
          height: mask.height,
          background: "var(--island-bg-color, #fff)",
          pointerEvents: "none",
          zIndex: 2,
        }}
      />,
    );
  }

  for (const badge of state.collapseBadges) {
    nodes.push(
      <button
        key={`ambient-collapse-badge-${badge.nodeId}`}
        type="button"
        data-testid="mind-map-collapse-badge"
        data-node-id={badge.nodeId}
        aria-label={`Expand ${badge.nodeCount} hidden node${badge.nodeCount === 1 ? "" : "s"}`}
        onClick={() => onExpand(badge.nodeId)}
        style={{
          position: "absolute",
          left: badge.left,
          top: badge.top,
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
        {badge.nodeCount}
      </button>,
    );
  }

  for (const pin of state.pinBadges) {
    nodes.push(
      <div
        key={`ambient-pin-badge-${pin.nodeId}`}
        data-testid="mind-map-pin-badge"
        aria-hidden
        style={{
          position: "absolute",
          left: pin.left,
          top: pin.top,
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
