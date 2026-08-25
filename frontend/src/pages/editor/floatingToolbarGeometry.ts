import { projectPoint } from "../../integrations/excalidraw/viewport";
import type { ElementSummary, ViewportState } from "../../integrations/excalidraw/types";

export type FloatingToolbarAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type FloatingToolbarObstacle = FloatingToolbarAnchor;

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

const placementBounds = (
  placement: Pick<ToolbarPlacement, "left" | "top">,
  toolbar: Size,
): FloatingToolbarAnchor => ({
  left: placement.left,
  top: placement.top,
  right: placement.left + toolbar.width,
  bottom: placement.top + toolbar.height,
});

const overlaps = (candidate: FloatingToolbarAnchor, obstacle: FloatingToolbarObstacle): boolean =>
  candidate.left < obstacle.right + ELEMENT_GAP &&
  candidate.right > obstacle.left - ELEMENT_GAP &&
  candidate.top < obstacle.bottom + ELEMENT_GAP &&
  candidate.bottom > obstacle.top - ELEMENT_GAP;

const fits = (
  placement: Pick<ToolbarPlacement, "left" | "top">,
  toolbar: Size,
  boundary: Size,
  obstacles: readonly FloatingToolbarObstacle[],
): boolean => {
  const bounds = placementBounds(placement, toolbar);
  return (
    bounds.left >= EDGE_GAP &&
    bounds.top >= EDGE_GAP &&
    bounds.right <= boundary.width - EDGE_GAP &&
    bounds.bottom <= boundary.height - EDGE_GAP &&
    obstacles.every((obstacle) => !overlaps(bounds, obstacle))
  );
};

const unique = (values: number[]): number[] => [
  ...new Set(values.map((value) => Math.round(value))),
];

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
  obstacles: readonly FloatingToolbarObstacle[] = [],
): ToolbarPlacement {
  const left = clamp(
    (anchor.left + anchor.right - toolbar.width) / 2,
    EDGE_GAP,
    boundary.width - EDGE_GAP - toolbar.width,
  );
  const above = anchor.top - ELEMENT_GAP - toolbar.height;
  const abovePlacement = { left, top: above, side: "above" } as const;
  if (fits(abovePlacement, toolbar, boundary, obstacles)) return abovePlacement;

  const below = anchor.bottom + ELEMENT_GAP;
  const belowPlacement = { left, top: below, side: "below" } as const;
  if (fits(belowPlacement, toolbar, boundary, obstacles)) return belowPlacement;

  const besideTop = clamp(
    (anchor.top + anchor.bottom - toolbar.height) / 2,
    EDGE_GAP,
    boundary.height - EDGE_GAP - toolbar.height,
  );
  const right = anchor.right + ELEMENT_GAP;
  const rightPlacement = { left: right, top: besideTop, side: "right" } as const;
  if (fits(rightPlacement, toolbar, boundary, obstacles)) return rightPlacement;
  const leftSide = anchor.left - ELEMENT_GAP - toolbar.width;
  const leftPlacement = { left: leftSide, top: besideTop, side: "left" } as const;
  if (fits(leftPlacement, toolbar, boundary, obstacles)) return leftPlacement;

  // Last resort: remain reachable inside the editor, but try every edge of a
  // known chrome obstacle before falling all the way back to rootBox + 8.
  const insideLefts = unique([
    left,
    EDGE_GAP,
    boundary.width - EDGE_GAP - toolbar.width,
    ...obstacles.flatMap((obstacle) => [
      obstacle.right + ELEMENT_GAP,
      obstacle.left - ELEMENT_GAP - toolbar.width,
    ]),
  ]).map((candidate) => clamp(candidate, EDGE_GAP, boundary.width - EDGE_GAP - toolbar.width));
  const insideTops = unique([
    EDGE_GAP,
    ...obstacles.flatMap((obstacle) => [
      obstacle.bottom + ELEMENT_GAP,
      obstacle.top - ELEMENT_GAP - toolbar.height,
    ]),
    boundary.height - EDGE_GAP - toolbar.height,
  ]).map((candidate) => clamp(candidate, EDGE_GAP, boundary.height - EDGE_GAP - toolbar.height));
  for (const insideLeft of insideLefts) {
    for (const insideTop of insideTops) {
      const candidate = { left: insideLeft, top: insideTop, side: "inside" } as const;
      if (fits(candidate, toolbar, boundary, obstacles)) return candidate;
    }
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
