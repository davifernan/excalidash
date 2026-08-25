import { describe, expect, it } from "vitest";
import { computeOffscreenMarkers, isOffscreen } from "./offscreenPresenceGeometry";

const SIZE = { width: 1000, height: 600 };

const peer = (id: string, point: { x: number; y: number }, color: string | null = "#ff0000") => ({
  id,
  name: `Peer ${id}`,
  color,
  point,
});

describe("isOffscreen", () => {
  it("is false for a point inside the viewport", () => {
    expect(isOffscreen({ x: 500, y: 300 }, SIZE)).toBe(false);
  });

  it("is true past every edge", () => {
    expect(isOffscreen({ x: -10, y: 300 }, SIZE)).toBe(true);
    expect(isOffscreen({ x: 1010, y: 300 }, SIZE)).toBe(true);
    expect(isOffscreen({ x: 500, y: -10 }, SIZE)).toBe(true);
    expect(isOffscreen({ x: 500, y: 610 }, SIZE)).toBe(true);
  });
});

describe("computeOffscreenMarkers", () => {
  it("produces no marker for a peer inside the viewport", () => {
    expect(computeOffscreenMarkers([peer("a", { x: 400, y: 300 })], SIZE)).toEqual([]);
  });

  it("clamps a single offscreen peer to the edge in their direction", () => {
    const markers = computeOffscreenMarkers([peer("a", { x: 5000, y: 300 })], SIZE);
    expect(markers).toHaveLength(1);
    const [marker] = markers;
    expect(marker.count).toBe(1);
    expect(marker.color).toBe("#ff0000");
    // Directly to the right of centre: clamped to the right edge, vertically centred.
    expect(marker.left).toBeCloseTo(SIZE.width - 22, 5);
    expect(marker.top).toBeCloseTo(SIZE.height / 2, 5);
  });

  it("stays inside the viewport rectangle for an off-axis peer", () => {
    const markers = computeOffscreenMarkers([peer("a", { x: 5000, y: -5000 })], SIZE);
    expect(markers).toHaveLength(1);
    const [marker] = markers;
    expect(marker.left).toBeLessThanOrEqual(SIZE.width);
    expect(marker.left).toBeGreaterThanOrEqual(0);
    expect(marker.top).toBeLessThanOrEqual(SIZE.height);
    expect(marker.top).toBeGreaterThanOrEqual(0);
  });

  it("clusters several peers in roughly the same direction into one marker", () => {
    const peers = [
      peer("a", { x: 5000, y: 250 }),
      peer("b", { x: 5000, y: 300 }),
      peer("c", { x: 5000, y: 350 }),
    ];
    const markers = computeOffscreenMarkers(peers, SIZE);
    expect(markers).toHaveLength(1);
    expect(markers[0].count).toBe(3);
    expect(markers[0].names).toEqual(["Peer a", "Peer b", "Peer c"]);
  });

  it("keeps peers in clearly different directions as separate markers", () => {
    const peers = [peer("a", { x: 5000, y: 300 }), peer("b", { x: -5000, y: 300 })];
    const markers = computeOffscreenMarkers(peers, SIZE);
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.count)).toEqual([1, 1]);
  });

  it("reports no shared colour when a cluster mixes colours", () => {
    const peers = [
      peer("a", { x: 5000, y: 280 }, "#ff0000"),
      peer("b", { x: 5000, y: 320 }, "#00ff00"),
    ];
    const markers = computeOffscreenMarkers(peers, SIZE);
    expect(markers).toHaveLength(1);
    expect(markers[0].color).toBeNull();
  });

  it("steps a marker clear of an obstacle it would otherwise land on", () => {
    // Directly above centre clamps to the top edge at x=500 -- exactly where
    // this obstacle (the measured main-toolbar collision, NIL-590) sits.
    const obstacle = { left: 400, top: 0, right: 600, bottom: 40 };
    const markers = computeOffscreenMarkers([peer("a", { x: 500, y: -5000 })], SIZE, undefined, [
      obstacle,
    ]);
    expect(markers).toHaveLength(1);
    const [marker] = markers;
    // No longer inside the obstacle box.
    expect(
      marker.left >= obstacle.left &&
        marker.left <= obstacle.right &&
        marker.top <= obstacle.bottom,
    ).toBe(false);
    // Still inside the viewport.
    expect(marker.top).toBeGreaterThanOrEqual(0);
    expect(marker.top).toBeLessThanOrEqual(SIZE.height);
  });

  it("leaves a marker alone when it does not overlap any obstacle", () => {
    const obstacle = { left: 0, top: 0, right: 100, bottom: 40 };
    const withoutObstacle = computeOffscreenMarkers([peer("a", { x: 5000, y: 300 })], SIZE);
    const withObstacle = computeOffscreenMarkers(
      [peer("a", { x: 5000, y: 300 })],
      SIZE,
      undefined,
      [obstacle],
    );
    expect(withObstacle).toEqual(withoutObstacle);
  });

  it("does not double-count the same direction split across the -180/180 seam", () => {
    // Both points sit almost due-left of centre, one a hair above the seam
    // angle and one a hair below it -- a naive bucket-by-raw-degrees split
    // would put these in two buckets even though they point the same way.
    const peers = [
      peer("a", { x: -5000, y: SIZE.height / 2 + 1 }),
      peer("b", { x: -5000, y: SIZE.height / 2 - 1 }),
    ];
    const markers = computeOffscreenMarkers(peers, SIZE);
    expect(markers).toHaveLength(1);
    expect(markers[0].count).toBe(2);
  });
});
