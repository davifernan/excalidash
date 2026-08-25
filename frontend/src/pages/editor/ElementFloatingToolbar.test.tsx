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
});
