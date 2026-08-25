import type { FloatingToolbarObstacle } from "./floatingToolbarGeometry";

export type OffscreenPeer = {
  readonly id: string;
  readonly name: string | null;
  readonly color: string | null;
  /** Already projected into viewport/screen space (viewport.toViewport). */
  readonly point: { readonly x: number; readonly y: number };
};

export type OffscreenMarker = {
  readonly key: string;
  readonly left: number;
  readonly top: number;
  /** Degrees, 0 = pointing right, increasing clockwise (screen space). */
  readonly angleDeg: number;
  /** Only set when every member of this marker shares one colour. */
  readonly color: string | null;
  readonly count: number;
  readonly names: readonly string[];
};

const EDGE_GAP = 22;
/** Marker box is 20x20 (OffscreenPresenceOverlay.css); half for overlap math. */
const MARKER_HALF = 12;
/** Breathing room once a marker has been pushed clear of an obstacle. */
const OBSTACLE_GAP = 6;

/**
 * Direction buckets a marker can fall into before it counts as "the same
 * place" as another. 20 degrees around a shared centre keeps a crowd on one
 * side of the board to a small handful of markers instead of one per person
 * -- NIL-590's first condition: "ein Rand voller Pfeile ist schlechter als
 * keiner". Bucket boundaries are normalised into [0, 360) so nobody pointing
 * near due-left splits across a -180/180 seam.
 */
const CLUSTER_BUCKET_DEG = 20;

export const isOffscreen = (
  point: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
): boolean => point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height;

const normaliseAngle = (angleDeg: number): number => ((angleDeg % 360) + 360) % 360;

/**
 * Push a direction vector out to the edge of the (gap-inset) viewport
 * rectangle, keeping its direction from the centre. This is the same
 * "ray from centre to target, clamped to the box" construction tldraw
 * documents for its off-screen collaborator hint
 * (https://tldraw.dev/sdk-features/cursors).
 */
const clampDirectional = (
  dx: number,
  dy: number,
  halfWidth: number,
  halfHeight: number,
): { readonly x: number; readonly y: number } => {
  if (dx === 0 && dy === 0) return { x: 0, y: -halfHeight };
  const scaleX = dx !== 0 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: dx * scale, y: dy * scale };
};

const rectFromCentre = (x: number, y: number, half: number): FloatingToolbarObstacle => ({
  left: x - half,
  top: y - half,
  right: x + half,
  bottom: y + half,
});

const overlapsObstacle = (marker: FloatingToolbarObstacle, obstacle: FloatingToolbarObstacle) =>
  marker.left < obstacle.right &&
  marker.right > obstacle.left &&
  marker.top < obstacle.bottom &&
  marker.bottom > obstacle.top;

/**
 * Nudge a clamped marker clear of chrome it landed on -- measured, not
 * assumed: an early version of this clamped straight to the top edge and
 * landed directly on the main toolbar (NIL-590 own screenshot evidence),
 * exactly the "clamps to the raw edge, ignores what's there" failure NIL-573
 * named for the floating element toolbar. Same obstacle source
 * (`findFloatingToolbarObstacleElements`) as that fix, applied to a point
 * instead of a box: try each side of the obstacle the marker could step to,
 * keep the one that costs the smallest move and still fits the viewport, and
 * leave the marker where it was if no side does.
 */
const resolveAgainstObstacles = (
  point: { readonly x: number; readonly y: number },
  obstacles: readonly FloatingToolbarObstacle[],
  bounds: { readonly width: number; readonly height: number },
  gap: number,
): { readonly x: number; readonly y: number } => {
  let current = point;
  for (const obstacle of obstacles) {
    const markerRect = rectFromCentre(current.x, current.y, MARKER_HALF);
    if (!overlapsObstacle(markerRect, obstacle)) continue;
    const candidates = [
      { x: current.x, y: obstacle.top - MARKER_HALF - OBSTACLE_GAP },
      { x: current.x, y: obstacle.bottom + MARKER_HALF + OBSTACLE_GAP },
      { x: obstacle.left - MARKER_HALF - OBSTACLE_GAP, y: current.y },
      { x: obstacle.right + MARKER_HALF + OBSTACLE_GAP, y: current.y },
    ].filter(
      (candidate) =>
        candidate.x >= gap &&
        candidate.x <= bounds.width - gap &&
        candidate.y >= gap &&
        candidate.y <= bounds.height - gap,
    );
    if (candidates.length === 0) continue;
    candidates.sort(
      (a, b) =>
        Math.hypot(a.x - current.x, a.y - current.y) - Math.hypot(b.x - current.x, b.y - current.y),
    );
    current = candidates[0];
  }
  return current;
};

/**
 * Peers currently outside the viewport, clamped to its edge and clustered by
 * direction. Self and on-screen peers never reach this -- Excalidraw already
 * draws their live cursor; this only covers what it cannot.
 */
export const computeOffscreenMarkers = (
  peers: readonly OffscreenPeer[],
  size: { readonly width: number; readonly height: number },
  gap: number = EDGE_GAP,
  obstacles: readonly FloatingToolbarObstacle[] = [],
): OffscreenMarker[] => {
  const halfWidth = size.width / 2 - gap;
  const halfHeight = size.height / 2 - gap;
  if (halfWidth <= 0 || halfHeight <= 0) return [];

  const buckets = new Map<number, { members: OffscreenPeer[]; dxSum: number; dySum: number }>();

  for (const peer of peers) {
    if (!isOffscreen(peer.point, size)) continue;
    const dx = peer.point.x - size.width / 2;
    const dy = peer.point.y - size.height / 2;
    const angleDeg = normaliseAngle((Math.atan2(dy, dx) * 180) / Math.PI);
    const bucketKey = Math.round(angleDeg / CLUSTER_BUCKET_DEG) % (360 / CLUSTER_BUCKET_DEG);
    const bucket = buckets.get(bucketKey) ?? { members: [], dxSum: 0, dySum: 0 };
    bucket.members.push(peer);
    bucket.dxSum += dx;
    bucket.dySum += dy;
    buckets.set(bucketKey, bucket);
  }

  const markers: OffscreenMarker[] = [];
  buckets.forEach((bucket, bucketKey) => {
    const avgDx = bucket.dxSum / bucket.members.length;
    const avgDy = bucket.dySum / bucket.members.length;
    const clamped = clampDirectional(avgDx, avgDy, halfWidth, halfHeight);
    const resolved = resolveAgainstObstacles(
      { x: size.width / 2 + clamped.x, y: size.height / 2 + clamped.y },
      obstacles,
      size,
      gap,
    );
    const colors = new Set(bucket.members.map((member) => member.color).filter(Boolean));
    markers.push({
      key: `offscreen-${bucketKey}`,
      left: resolved.x,
      top: resolved.y,
      angleDeg: normaliseAngle((Math.atan2(avgDy, avgDx) * 180) / Math.PI),
      color: colors.size === 1 ? ([...colors][0] as string) : null,
      count: bucket.members.length,
      names: bucket.members.map((member) => member.name ?? "Participant"),
    });
  });

  return markers;
};
