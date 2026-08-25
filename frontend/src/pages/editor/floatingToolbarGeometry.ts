import { projectPoint } from "../../integrations/excalidraw/viewport";
import type { ElementSummary, ViewportState } from "../../integrations/excalidraw/types";

export type FloatingToolbarAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type Size = { width: number; height: number };
export type ToolbarPlacement = {
  left: number;
  top: number;
  side: "above" | "below" | "left" | "right" | "inside";
};

const EDGE_GAP = 8;
const ELEMENT_GAP = 8;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

/**
 * Place an unscaled toolbar around a viewport-space element.
 *
 * Above is the normal position. At the top edge it deliberately flips below
 * the element; horizontal clamping is independent, so neither a narrow widget
 * nor a note near a corner can push the toolbar outside the editor.
 */
export function placeFloatingToolbar(
  anchor: FloatingToolbarAnchor,
  toolbar: Size,
  boundary: Size,
): ToolbarPlacement {
  const left = clamp(
    (anchor.left + anchor.right - toolbar.width) / 2,
    EDGE_GAP,
    boundary.width - EDGE_GAP - toolbar.width,
  );
  const above = anchor.top - ELEMENT_GAP - toolbar.height;
  if (above >= EDGE_GAP) return { left, top: above, side: "above" };

  const below = anchor.bottom + ELEMENT_GAP;
  if (below + toolbar.height <= boundary.height - EDGE_GAP) {
    return { left, top: below, side: "below" };
  }

  const besideTop = clamp(
    (anchor.top + anchor.bottom - toolbar.height) / 2,
    EDGE_GAP,
    boundary.height - EDGE_GAP - toolbar.height,
  );
  const right = anchor.right + ELEMENT_GAP;
  if (right + toolbar.width <= boundary.width - EDGE_GAP) {
    return { left: right, top: besideTop, side: "right" };
  }
  const leftSide = anchor.left - ELEMENT_GAP - toolbar.width;
  if (leftSide >= EDGE_GAP) {
    return { left: leftSide, top: besideTop, side: "left" };
  }

  return { left, top: EDGE_GAP, side: "inside" };
}

/** True only for this element and a local selection of exactly one element. */
export function isOnlySelectedElement(
  selectedElementIds: Record<string, unknown> | null | undefined,
  elementId: string,
): boolean {
  if (!selectedElementIds) return false;
  const selected = Object.entries(selectedElementIds).filter(([, value]) => value === true);
  return selected.length === 1 && selected[0][0] === elementId;
}

/** Axis-aligned viewport bounds of an element, including rotation. */
export function elementViewportBounds(
  element: Pick<ElementSummary, "x" | "y" | "width" | "height" | "angle">,
  viewport: ViewportState,
): FloatingToolbarAnchor {
  const centreX = element.x + element.width / 2;
  const centreY = element.y + element.height / 2;
  const cos = Math.cos(element.angle);
  const sin = Math.sin(element.angle);
  const corners = [
    [-element.width / 2, -element.height / 2],
    [element.width / 2, -element.height / 2],
    [element.width / 2, element.height / 2],
    [-element.width / 2, element.height / 2],
  ].map(([x, y]) =>
    projectPoint({ x: centreX + x * cos - y * sin, y: centreY + x * sin + y * cos }, viewport),
  );
  return {
    left: Math.min(...corners.map(({ x }) => x)),
    top: Math.min(...corners.map(({ y }) => y)),
    right: Math.max(...corners.map(({ x }) => x)),
    bottom: Math.max(...corners.map(({ y }) => y)),
  };
}

export type FloatingToolbarTarget = {
  host: HTMLElement;
  /** Client-viewport coordinates, translated to the host by the component. */
  anchor: FloatingToolbarAnchor;
};
