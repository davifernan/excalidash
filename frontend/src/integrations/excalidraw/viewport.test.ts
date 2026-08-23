import { describe, expect, it, vi } from "vitest";

import { createViewportCapability, parseBounds, readViewport, wouldClampZoom } from "./viewport";
import type { SceneBounds } from "./types";

const appState = (over: Record<string, unknown> = {}) => ({
  zoom: { value: 2 },
  scrollX: 100,
  scrollY: 50,
  offsetLeft: 10,
  offsetTop: 20,
  width: 1280,
  height: 720,
  ...over,
});

describe("reading the viewport", () => {
  it("unwraps the editor's zoom object", () => {
    expect(readViewport(appState()).zoom).toBe(2);
  });

  it("accepts a bare number too, rather than reporting zoom 1 for a moved board", () => {
    expect(readViewport(appState({ zoom: 3 })).zoom).toBe(3);
  });

  it("falls back to a sane zoom rather than NaN when the shape is gone", () => {
    expect(readViewport(appState({ zoom: undefined })).zoom).toBe(1);
  });
});

describe("parsing scene bounds", () => {
  it("takes four finite numbers", () => {
    expect(parseBounds([0, 0, 10, 10])).toEqual([0, 0, 10, 10]);
  });

  it("refuses a half-read bound rather than passing a NaN onwards", () => {
    expect(parseBounds([0, 0, 10])).toBeNull();
    expect(parseBounds([0, 0, 10, Number.NaN])).toBeNull();
    expect(parseBounds([0, 0, 10, "10"])).toBeNull();
    expect(parseBounds(null)).toBeNull();
  });
});

describe("knowing when a fit will be clamped", () => {
  it("says no for bounds that fit inside the limits", () => {
    expect(wouldClampZoom(appState(), [0, 0, 1000, 600] as SceneBounds)).toBe(false);
  });

  it("says yes when the board is far too large to fit", () => {
    expect(wouldClampZoom(appState(), [0, 0, 1_000_000, 1_000_000] as SceneBounds)).toBe(true);
  });

  it("says yes when the board is far too small, which zooms past the maximum", () => {
    expect(wouldClampZoom(appState(), [0, 0, 1, 1] as SceneBounds)).toBe(true);
  });

  it("reads the viewport size, not the zoom -- so it can be asked before the fit", () => {
    // The earlier version of this test varied `zoom` between "before" and
    // "after" and asserted the same result, which proved nothing: this function
    // never reads zoom. What actually decides the answer is width and height,
    // and zoomToFitBounds does not change those -- which is why asking before
    // the write is meaningful at all.
    const bounds = [0, 0, 1, 1] as SceneBounds;
    expect(wouldClampZoom(appState({ zoom: { value: 1 } }), bounds)).toBe(true);
    expect(wouldClampZoom(appState({ zoom: { value: 30 } }), bounds)).toBe(true);

    // Change what it does read, and the answer moves.
    expect(wouldClampZoom(appState({ width: 20, height: 20 }), bounds)).toBe(false);
  });
});

describe("the viewport capability without an editor", () => {
  const capability = createViewportCapability(() => null);

  it("reports not-ready rather than throwing", () => {
    const result = capability.read();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not-ready");
  });

  it("hands back a no-op unsubscribe", () => {
    expect(() => capability.subscribeScroll(() => {})()).not.toThrow();
  });
});

describe("converting a viewport point back to the scene", () => {
  it("inverts the editor's transform", () => {
    const api = {
      getAppState: () => appState(),
      updateScene: vi.fn(),
      getSceneElements: () => [],
    };
    const capability = createViewportCapability(() => api);
    const result = capability.toScene({ x: 10, y: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // (10 - 10) / 2 - 100 = -100 ; (20 - 20) / 2 - 50 = -50
      expect(result.value).toEqual({ x: -100, y: -50 });
    }
  });
});

describe("showBounds reports what actually happened", () => {
  const api = () => ({
    getAppState: () => appState(),
    updateScene: vi.fn(),
    getSceneElements: () => [],
  });

  it("reports the clamp when the board cannot fit inside the zoom limits", () => {
    const result = createViewportCapability(api).showBounds([
      0, 0, 1_000_000, 1_000_000,
    ] as SceneBounds);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.zoomClamped).toBe(true);
  });

  it("reports no clamp for a fit that lands inside them", () => {
    const result = createViewportCapability(api).showBounds([0, 0, 1000, 600] as SceneBounds);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.zoomClamped).toBe(false);
  });

  it("applies the fit through a single updateScene call", () => {
    const editor = api();
    createViewportCapability(() => editor).showBounds([0, 0, 1000, 600] as SceneBounds);
    expect(editor.updateScene).toHaveBeenCalledTimes(1);
  });

  it("hands back the viewport it got, not the one it asked for", () => {
    const result = createViewportCapability(api).showBounds([0, 0, 1000, 600] as SceneBounds);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.viewport.zoom).toBe("number");
      expect(Number.isFinite(result.value.viewport.zoom)).toBe(true);
    }
  });
});

describe("scrolling to an element that is not there", () => {
  it("reports invalid-state rather than showing an empty rectangle at the origin", () => {
    const api = {
      getAppState: () => appState(),
      updateScene: vi.fn(),
      getSceneElements: () => [],
    };
    const capability = createViewportCapability(() => api);
    const result = capability.scrollToElement("ghost" as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-state");
  });
});
