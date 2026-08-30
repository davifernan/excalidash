import { placeFloatingToolbar } from "./floatingToolbarGeometry";

export type ScreenRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export type ProjectedThreadAnchor = {
  readonly threadId: string;
  readonly elementId: string;
  readonly title: string;
  readonly rect: ScreenRect;
};

export type ThreadAnchorReference = Pick<ProjectedThreadAnchor, "threadId" | "elementId">;

export type ThreadPanelMode = "closed" | "anchored" | "docked";
export type DockDirection = "left" | "right" | "up" | "down";

export type ThreadPanelPlacement = {
  readonly mode: Exclude<ThreadPanelMode, "closed">;
  readonly panelRect: ScreenRect;
  readonly direction: DockDirection | null;
  readonly distance: number;
};

export type ThreadVisualCluster = {
  readonly id: string;
  readonly members: readonly ThreadAnchorReference[];
  readonly rect: ScreenRect;
};

export type ThreadOffscreenLocator = {
  readonly id: string;
  readonly direction: DockDirection;
  readonly members: readonly ThreadAnchorReference[];
  readonly left: number;
  readonly top: number;
};

export type ClusterNavigation = {
  readonly kind: "navigate";
  readonly threadId: string;
  readonly elementId: string;
};

const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 286;
const VIEWPORT_MARGIN = 18;
const READABLE_ENTER = { width: 190, height: 120 };
const READABLE_EXIT = { width: 150, height: 96 };
const SATURATION_RATIO = 0.35;

const panelSize = (viewport: { readonly width: number; readonly height: number }) => ({
  width: Math.max(1, Math.min(PANEL_WIDTH, viewport.width - VIEWPORT_MARGIN * 2)),
  height: Math.max(1, Math.min(PANEL_HEIGHT, viewport.height - VIEWPORT_MARGIN * 2)),
});

const widthOf = (rect: ScreenRect) => Math.max(0, rect.right - rect.left);
const heightOf = (rect: ScreenRect) => Math.max(0, rect.bottom - rect.top);

const overlaps = (left: ScreenRect, right: ScreenRect): boolean =>
  left.left < right.right &&
  left.right > right.left &&
  left.top < right.bottom &&
  left.bottom > right.top;

const unionRect = (rects: readonly ScreenRect[]): ScreenRect => ({
  left: Math.min(...rects.map((rect) => rect.left)),
  top: Math.min(...rects.map((rect) => rect.top)),
  right: Math.max(...rects.map((rect) => rect.right)),
  bottom: Math.max(...rects.map((rect) => rect.bottom)),
});

const fitsViewport = (
  rect: ScreenRect,
  viewport: { readonly width: number; readonly height: number },
): boolean =>
  rect.left >= VIEWPORT_MARGIN &&
  rect.top >= VIEWPORT_MARGIN &&
  rect.right <= viewport.width - VIEWPORT_MARGIN &&
  rect.bottom <= viewport.height - VIEWPORT_MARGIN;

const readable = (
  rect: ScreenRect,
  viewport: { readonly width: number; readonly height: number },
  threshold: { readonly width: number; readonly height: number },
): boolean =>
  fitsViewport(rect, viewport) &&
  widthOf(rect) >= threshold.width &&
  heightOf(rect) >= threshold.height;

const anchoredPanelRect = (
  anchor: ScreenRect,
  viewport: { readonly width: number; readonly height: number },
  obstacles: readonly ScreenRect[],
): ScreenRect | null => {
  const size = panelSize(viewport);
  const placement = placeFloatingToolbar(anchor, size, viewport, obstacles);
  // The toolbar helper's "inside" result is a reachable last resort but no
  // longer preserves an intelligible anchor relationship. For a thread this
  // is exactly the transition to the explicit docked state.
  if (placement.side === "inside") return null;
  return {
    left: placement.left,
    top: placement.top,
    right: placement.left + size.width,
    bottom: placement.top + size.height,
  };
};

const dockDirection = (
  rect: ScreenRect,
  viewport: { readonly width: number; readonly height: number },
): DockDirection => {
  const dx = (rect.left + rect.right) / 2 - viewport.width / 2;
  const dy = (rect.top + rect.bottom) / 2 - viewport.height / 2;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
};

const dockedPanelRect = (
  _direction: DockDirection,
  viewport: { readonly width: number; readonly height: number },
): ScreenRect => {
  const size = panelSize(viewport);
  // The direction describes where the anchor is, not where the panel must be.
  // A stable right-centre dock stays clear of Excalidraw's top toolbar and
  // avoids a second visual jump when an anchor crosses a viewport corner.
  const left = Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - size.width);
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(viewport.height - VIEWPORT_MARGIN - size.height, (viewport.height - size.height) / 2),
  );
  return { left, top, right: left + size.width, bottom: top + size.height };
};

/**
 * The three display stages are a state machine, not sizes. `closed` lives in
 * the caller as the absence of an open id; this function chooses between the
 * two open states. The two readability thresholds are geometric hysteresis:
 * an anchored panel may stay anchored below the stricter entry threshold,
 * while a docked panel does not jump back until its board card is clearly
 * readable again.
 */
export const resolveOpenThreadPanel = ({
  anchor,
  viewport,
  previousMode,
  obstacles = [],
}: {
  readonly anchor: ProjectedThreadAnchor;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly previousMode: ThreadPanelMode;
  readonly obstacles?: readonly ScreenRect[];
}): ThreadPanelPlacement => {
  const threshold = previousMode === "anchored" ? READABLE_EXIT : READABLE_ENTER;
  const panelRect = readable(anchor.rect, viewport, threshold)
    ? anchoredPanelRect(anchor.rect, viewport, obstacles)
    : null;
  if (panelRect) {
    return { mode: "anchored", panelRect, direction: null, distance: 0 };
  }

  const direction = dockDirection(anchor.rect, viewport);
  const centreX = (anchor.rect.left + anchor.rect.right) / 2;
  const centreY = (anchor.rect.top + anchor.rect.bottom) / 2;
  const nearestX = Math.min(viewport.width, Math.max(0, centreX));
  const nearestY = Math.min(viewport.height, Math.max(0, centreY));
  return {
    mode: "docked",
    panelRect: dockedPanelRect(direction, viewport),
    direction,
    distance: Math.round(Math.hypot(centreX - nearestX, centreY - nearestY)),
  };
};

/** One id is the entire local open-state model, so opening B closes A. */
export const selectOpenThread = (current: string | null, requested: string): string | null =>
  current === requested ? null : requested;

/**
 * Connected components of overlapping projected cards. This function returns
 * only visual membership and bounds; it never moves, combines or rewrites the
 * underlying thread anchors.
 */
export const clusterThreadAnchors = (
  anchors: readonly ProjectedThreadAnchor[],
): ThreadVisualCluster[] => {
  // customData survives Excalidraw duplication, so threadId names the logical
  // thread but cannot identify one concrete Board Card. Geometry is always
  // keyed by the unique elementId of the address being projected.
  const unseen = new Set(anchors.map((item) => item.elementId));
  const byId = new Map(anchors.map((item) => [item.elementId, item] as const));
  const clusters: ThreadVisualCluster[] = [];

  for (const seed of anchors) {
    if (!unseen.delete(seed.elementId)) continue;
    const members = [seed];
    for (let cursor = 0; cursor < members.length; cursor += 1) {
      const current = members[cursor]!;
      for (const candidateId of [...unseen]) {
        const candidate = byId.get(candidateId)!;
        if (!overlaps(current.rect, candidate.rect)) continue;
        unseen.delete(candidateId);
        members.push(candidate);
      }
    }
    const memberReferences = members
      .map(({ threadId, elementId }) => ({ threadId, elementId }))
      .sort((left, right) => left.elementId.localeCompare(right.elementId));
    clusters.push({
      id: `thread-cluster:${memberReferences.map((item) => item.elementId).join(":")}`,
      members: memberReferences,
      rect: unionRect(members.map((item) => item.rect)),
    });
  }
  return clusters;
};

export const isThreadAnchorOffscreen = (
  anchor: ProjectedThreadAnchor,
  viewport: { readonly width: number; readonly height: number },
): boolean =>
  anchor.rect.right < 0 ||
  anchor.rect.bottom < 0 ||
  anchor.rect.left > viewport.width ||
  anchor.rect.top > viewport.height;

/**
 * Closed offscreen threads collapse to at most four directional locators.
 * The locator retains identities for disambiguation but, like an overlap
 * cluster, owns no operation beyond navigating to one original thread.
 */
export const computeOffscreenThreadLocators = (
  anchors: readonly ProjectedThreadAnchor[],
  viewport: { readonly width: number; readonly height: number },
): ThreadOffscreenLocator[] => {
  const byDirection = new Map<DockDirection, ThreadAnchorReference[]>();
  for (const anchor of anchors) {
    if (!isThreadAnchorOffscreen(anchor, viewport)) continue;
    const direction = dockDirection(anchor.rect, viewport);
    const members = byDirection.get(direction) ?? [];
    members.push({ threadId: anchor.threadId, elementId: anchor.elementId });
    byDirection.set(direction, members);
  }

  return [...byDirection.entries()].map(([direction, members]) => {
    const edge = 34;
    const left =
      direction === "left"
        ? edge
        : direction === "right"
          ? viewport.width - edge
          : viewport.width / 2;
    // Keep the upward locator below the main toolbar rather than clamping to
    // the raw top edge. Other directions sit at their edge midpoint.
    const top =
      direction === "up" ? 82 : direction === "down" ? viewport.height - edge : viewport.height / 2;
    const sorted = [...members].sort((left, right) =>
      left.elementId.localeCompare(right.elementId),
    );
    return {
      id: `thread-offscreen:${direction}`,
      direction,
      members: sorted,
      left,
      top,
    };
  });
};

/**
 * A cluster click can only disambiguate/navigation to one original thread.
 * Keeping this action deliberately smaller than the runtime/Context APIs is
 * the executable V3 boundary: visual proximity cannot create Context,
 * Dispatch or Lease meaning.
 */
export const activateClusterMember = (
  cluster: ThreadVisualCluster,
  elementId: string,
): ClusterNavigation | null => {
  const member = cluster.members.find((candidate) => candidate.elementId === elementId);
  return member ? { kind: "navigate", ...member } : null;
};

const clippedRect = (
  rect: ScreenRect,
  viewport: { readonly width: number; readonly height: number },
): ScreenRect | null => {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.right);
  const bottom = Math.min(viewport.height, rect.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
};

const unionArea = (rects: readonly ScreenRect[]): number => {
  const xs = [...new Set(rects.flatMap((rect) => [rect.left, rect.right]))].sort((a, b) => a - b);
  let area = 0;
  for (let index = 0; index < xs.length - 1; index += 1) {
    const left = xs[index]!;
    const right = xs[index + 1]!;
    const intervals = rects
      .filter((rect) => rect.left < right && rect.right > left)
      .map((rect) => [rect.top, rect.bottom] as const)
      .sort((a, b) => a[0] - b[0]);
    let coveredY = 0;
    let start: number | null = null;
    let end: number | null = null;
    for (const [nextStart, nextEnd] of intervals) {
      if (start === null || end === null) {
        start = nextStart;
        end = nextEnd;
      } else if (nextStart <= end) {
        end = Math.max(end, nextEnd);
      } else {
        coveredY += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }
    if (start !== null && end !== null) coveredY += end - start;
    area += (right - left) * coveredY;
  }
  return area;
};

/**
 * Backpressure follows representation saturation, not a magic thread count.
 * Twenty small, separated cards can remain readable while two giant cards can
 * consume the board. The returned message is part of the contract: blocking
 * public coordination without showing the block would be silent failure.
 */
export const computeCoordinationBackpressure = (
  anchors: readonly ProjectedThreadAnchor[],
  viewport: { readonly width: number; readonly height: number },
): {
  readonly blocked: boolean;
  readonly occupiedRatio: number;
  readonly message: string | null;
} => {
  const viewportArea = Math.max(1, viewport.width * viewport.height);
  const visibleRects = anchors
    .map((item) => clippedRect(item.rect, viewport))
    .filter((rect): rect is ScreenRect => rect !== null);
  const occupiedRatio = Math.min(1, unionArea(visibleRects) / viewportArea);
  const blocked = occupiedRatio >= SATURATION_RATIO;
  return {
    blocked,
    occupiedRatio,
    message: blocked ? "Thread view saturated — public coordination waits for visible room." : null,
  };
};
