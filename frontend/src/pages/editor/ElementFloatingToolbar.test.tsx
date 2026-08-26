import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ElementFloatingToolbar } from "./ElementFloatingToolbar";
import {
  elementViewportBounds,
  isOnlySelectedElement,
  placeFloatingToolbar,
} from "./floatingToolbarGeometry";

describe("floating element toolbar geometry", () => {
  it("keeps toolbar pixels constant while the element follows zoom", () => {
    const element = { x: 100, y: 100, width: 200, height: 100, angle: 0 };
    const viewport = (zoom: number) => ({
      zoom,
      scrollX: 0,
      scrollY: 0,
      offsetLeft: 0,
      offsetTop: 0,
      width: 1200,
      height: 800,
    });
    const toolbar = { width: 280, height: 42 };
    const boundary = { width: 1200, height: 800 };

    const at50 = elementViewportBounds(element as never, viewport(0.5));
    const at100 = elementViewportBounds(element as never, viewport(1));
    const at200 = elementViewportBounds(element as never, viewport(2));

    expect(at50.right - at50.left).toBe(100);
    expect(at100.right - at100.left).toBe(200);
    expect(at200.right - at200.left).toBe(400);
    expect(
      [at50, at100, at200].map((anchor) => placeFloatingToolbar(anchor, toolbar, boundary)),
    ).toHaveLength(3);
    expect(toolbar).toEqual({ width: 280, height: 42 });
  });

  it("flips below a small element at the top edge", () => {
    expect(
      placeFloatingToolbar(
        { left: 300, top: 4, right: 500, bottom: 104 },
        { width: 280, height: 42 },
        { width: 1000, height: 700 },
      ),
    ).toEqual({ left: 260, top: 112, side: "below" });
  });

  it("flips below when the nominal above position crosses the tool island", () => {
    expect(
      placeFloatingToolbar(
        { left: 300, top: 100, right: 700, bottom: 500 },
        { width: 280, height: 42 },
        { width: 1000, height: 700 },
        [{ left: 280, top: 8, right: 720, bottom: 64 }],
      ),
    ).toEqual({ left: 360, top: 508, side: "below" });
  });

  /**
   * NIL-600: the "clears known chrome" test above always had a valid gap to
   * escape into. This one does not -- two obstacles leave only a 10px
   * vertical sliver in a 300px-tall boundary, nowhere near the 42px-tall
   * toolbar. Every gap-respecting candidate in the function genuinely
   * fails here, which is exactly the geometry that used to reach the old
   * unconditional `{ left, top: EDGE_GAP }` fallback -- the one candidate
   * in this whole function that never checked an obstacle. `EDGE_GAP` (8)
   * sits inside the first obstacle's own 0-140 span, so that old fallback
   * placed the toolbar ON TOP of an obstacle it already knew about: a
   * document widget's page-turn button rendered "visible, enabled,
   * stable" by every browser/CSS measure, directly under a toast that
   * still ate its pointer events (measured live in the NIL-330 baseline
   * soak, not assumed). The fix keeps the same grid this function already
   * builds and picks whichever candidate overlaps the LEAST, rather than
   * giving up on avoidance entirely once nothing is perfect.
   */
  it("picks the least-overlapping position instead of an unconditional corner when nothing fully clears (NIL-600)", () => {
    const toolbar = { width: 280, height: 42 };
    const boundary = { width: 400, height: 300 };
    const obstacles = [
      { left: 0, top: 0, right: 400, bottom: 140 },
      { left: 0, top: 150, right: 400, bottom: 300 },
    ];
    const placement = placeFloatingToolbar(
      { left: 0, top: 145, right: 400, bottom: 146 },
      toolbar,
      boundary,
      obstacles,
    );
    const bounds = {
      left: placement.left,
      top: placement.top,
      right: placement.left + toolbar.width,
      bottom: placement.top + toolbar.height,
    };
    const overlapWith = (o: (typeof obstacles)[number]) =>
      Math.max(0, Math.min(bounds.right, o.right) - Math.max(bounds.left, o.left)) *
      Math.max(0, Math.min(bounds.bottom, o.bottom) - Math.max(bounds.top, o.top));
    const totalOverlap = obstacles.reduce((sum, o) => sum + overlapWith(o), 0);
    const oldFallbackOverlap = (() => {
      const oldBounds = { left: 60, top: 8, right: 60 + toolbar.width, bottom: 8 + toolbar.height };
      return obstacles.reduce(
        (sum, o) =>
          sum +
          Math.max(0, Math.min(oldBounds.right, o.right) - Math.max(oldBounds.left, o.left)) *
            Math.max(0, Math.min(oldBounds.bottom, o.bottom) - Math.max(oldBounds.top, o.top)),
        0,
      );
    })();
    expect(oldFallbackOverlap).toBeGreaterThan(0); // sanity: the old fallback really did sit in an obstacle here
    expect(totalOverlap).toBeLessThan(oldFallbackOverlap);
  });

  it("clears known chrome even in the inside last resort", () => {
    expect(
      placeFloatingToolbar(
        { left: 100, top: -200, right: 900, bottom: 900 },
        { width: 280, height: 42 },
        { width: 1000, height: 700 },
        [{ left: 280, top: 8, right: 720, bottom: 64 }],
      ),
    ).toEqual({ left: 360, top: 72, side: "inside" });
  });

  it("moves beside a tall top-edge element and stays inside horizontally", () => {
    const placement = placeFloatingToolbar(
      { left: 100, top: -20, right: 580, bottom: 680 },
      { width: 280, height: 42 },
      { width: 1000, height: 700 },
    );
    expect(placement).toEqual({ left: 588, top: 309, side: "right" });
    expect(placement.left + 280).toBeLessThanOrEqual(992);
  });

  it("shows one local target for one selection and none for a multi-selection", () => {
    expect(isOnlySelectedElement({ pdf: true }, "pdf")).toBe(true);
    expect(isOnlySelectedElement({ pdf: true, other: true }, "pdf")).toBe(false);
    expect(isOnlySelectedElement({ pdf: false }, "pdf")).toBe(false);
  });

  it("does not remeasure when a parent recreates an equal target", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const hostRect = vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    });
    const anchor = { left: 300, top: 200, right: 500, bottom: 400 };
    const { rerender, unmount } = render(
      <ElementFloatingToolbar target={{ host, anchor }} label="Test controls">
        controls
      </ElementFloatingToolbar>,
    );
    expect(hostRect).toHaveBeenCalledTimes(1);

    rerender(
      <ElementFloatingToolbar target={{ host, anchor: { ...anchor } }} label="Test controls">
        controls
      </ElementFloatingToolbar>,
    );
    expect(hostRect).toHaveBeenCalledTimes(1);
    unmount();
    host.remove();
  });

  // NIL-589: a toast is `position: fixed` outside the Excalidraw root and
  // wins visually over the toolbar's z-index:6 whenever they land on the
  // same screen spot -- see findFloatingToolbarObstacleElements's own
  // comment in domBridge.ts. This proves the two pieces actually connect:
  // an active toast sibling of `host` changes where the toolbar renders,
  // not just that the obstacle-finder returns it in isolation.
  it("places itself clear of an active toast stack outside the editor root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    } as DOMRect);

    const toaster = document.createElement("div");
    toaster.setAttribute("data-sonner-toaster", "");
    toaster.innerHTML = "<li data-sonner-toast></li>";
    document.body.append(toaster);
    // Covers the whole host: no placement (above/below/left/right) can clear
    // it, forcing the geometry's last-resort "inside" fallback -- proof the
    // toast obstacle reached `placeFloatingToolbar` at all, without relying
    // on exact pixel math for a jsdom-measured (zero-size) toolbar.
    vi.spyOn(toaster, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    } as DOMRect);

    const anchor = { left: 300, top: 300, right: 500, bottom: 400 };
    const { unmount, getByRole } = render(
      <ElementFloatingToolbar target={{ host, anchor }} label="Test controls">
        controls
      </ElementFloatingToolbar>,
    );

    const toolbar = getByRole("toolbar");
    expect(toolbar.dataset.placement).toBe("inside");
    unmount();
    host.remove();
    toaster.remove();
  });
});
