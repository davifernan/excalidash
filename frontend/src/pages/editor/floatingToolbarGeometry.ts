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
 * How much of `candidate` a single obstacle actually covers, in pixels of
 * overlap area -- 0 when they do not touch at all. Ignores `ELEMENT_GAP`
 * on purpose: this only runs once every gap-respecting candidate (`fits`,
 * everywhere above) has already failed, to rank what is left by how badly
 * clickable it would be, not to repeat the same gap check.
 */
const overlapArea = (
  candidate: FloatingToolbarAnchor,
  obstacle: FloatingToolbarObstacle,
): number => {
  const width = Math.max(
    0,
    Math.min(candidate.right, obstacle.right) - Math.max(candidate.left, obstacle.left),
  );
  const height = Math.max(
    0,
    Math.min(candidate.bottom, obstacle.bottom) - Math.max(candidate.top, obstacle.top),
  );
  return width * height;
};

const totalOverlapArea = (
  candidate: FloatingToolbarAnchor,
  obstacles: readonly FloatingToolbarObstacle[],
): number => obstacles.reduce((sum, obstacle) => sum + overlapArea(candidate, obstacle), 0);

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

  // Truly nothing clears every obstacle at once (NIL-600) -- a real gap the
  // grid above cannot close in a small enough boundary crowded enough with
  // its own chrome, a toast, or both. The OLD fallback here was
  // `{ left, top: EDGE_GAP, side: "inside" }` unconditionally: the one
  // candidate in this whole function that never checked an obstacle at
  // all, which is exactly how a toast ends up sitting on top of a document
  // widget's page-turn button -- reachable, visible, "stable" by every
  // Playwright/CSS measure, and still not clickable, because pointer
  // events go to whatever the browser paints on top, not to whichever
  // side lost this search. Score every candidate already computed above
  // (edge-clamped anchor-left plus every obstacle-derived left/top,
  // exactly the same grid) by how many pixels of obstacle it still
  // overlaps, and keep the least-bad one -- so a toolbar that cannot fully
  // escape a crowded corner at least ends up under the SMALLEST usable
  // sliver of an obstacle instead of arbitrarily under the toast itself.
  let best = { left, top: EDGE_GAP, side: "inside" as const };
  let bestOverlap = totalOverlapArea(placementBounds(best, toolbar), obstacles);
  for (const insideLeft of insideLefts) {
    for (const insideTop of insideTops) {
      const candidate = { left: insideLeft, top: insideTop, side: "inside" as const };
      const overlap = totalOverlapArea(placementBounds(candidate, toolbar), obstacles);
      if (overlap < bestOverlap) {
        best = candidate;
        bestOverlap = overlap;
        if (bestOverlap === 0) return best;
      }
    }
  }
  return best;
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
