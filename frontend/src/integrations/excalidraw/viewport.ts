/**
 * Viewport: where the board is being looked at, and how to move that.
 *
 * The one decision worth naming here is that showBounds returns what actually
 * happened rather than an acknowledgement. Follow mode compares the viewport it
 * got against the one it asked for, and tells the user when the zoom hit a
 * limit; with a `void` result it would have to recompute the geometry itself or
 * read back a state that may already have moved on.
 */

import {
  getVisibleSceneBounds,
  sceneCoordsToViewportCoords,
  zoomToFitBounds,
} from "@excalidraw/excalidraw";

import { reportFailure } from "./compatibility/diagnostics";
import type { ViewportCapability } from "./capabilities";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type {
  AppliedViewport,
  ElementId,
  SceneBounds,
  ScenePoint,
  Unsubscribe,
  ViewportPoint,
  ViewportState,
} from "./types";
import { packageVersion } from "./version";

/** Excalidraw's own zoom limits. Product code has no business knowing these. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

export type ViewportApi = {
  getAppState: () => Record<string, unknown>;
  updateScene: (change: Record<string, unknown>) => void;
  onScrollChange?: (listener: () => void) => Unsubscribe;
  scrollToContent?: (target: unknown, options?: unknown) => void;
  getSceneElements: () => readonly unknown[];
};

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const readViewport = (appState: Record<string, unknown>): ViewportState => {
  const zoom = appState.zoom;
  return {
    zoom:
      zoom && typeof zoom === "object" && "value" in zoom
        ? num((zoom as { value: unknown }).value, 1)
        : num(zoom, 1),
    scrollX: num(appState.scrollX, 0),
    scrollY: num(appState.scrollY, 0),
    offsetLeft: num(appState.offsetLeft, 0),
    offsetTop: num(appState.offsetTop, 0),
    width: num(appState.width, 0),
    height: num(appState.height, 0),
  };
};

/** Four finite numbers, or nothing. A half-read bound is worse than none. */
export const parseBounds = (value: unknown): SceneBounds | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return [value[0], value[1], value[2], value[3]] as SceneBounds;
};

/**
 * Would this fit be clamped?
 *
 * Asked before applying, because afterwards the applied zoom is already inside
 * the limits and the fact that it was cut off is gone.
 */
export const wouldClampZoom = (appState: Record<string, unknown>, bounds: SceneBounds): boolean => {
  const width = num(appState.width, 0);
  const height = num(appState.height, 0);
  const spanX = bounds[2] - bounds[0];
  const spanY = bounds[3] - bounds[1];
  if (spanX <= 0 || spanY <= 0) return false;
  const desired = Math.min(width / spanX, height / spanY);
  return desired < MIN_ZOOM || desired > MAX_ZOOM;
};

/**
 * Scene point to viewport point, against a viewport this caller already holds.
 *
 * Separate from the capability's `toViewport`, which reads the live editor: the
 * follow indicator draws a rectangle for a viewport that was just computed and
 * not necessarily the one on screen, so it has to be able to say which.
 */
export const projectPoint = (point: ScenePoint, viewport: ViewportState): ViewportPoint => {
  const converted = sceneCoordsToViewportCoords(
    { sceneX: point.x, sceneY: point.y } as never,
    {
      zoom: { value: viewport.zoom },
      scrollX: viewport.scrollX,
      scrollY: viewport.scrollY,
      offsetLeft: viewport.offsetLeft,
      offsetTop: viewport.offsetTop,
    } as never,
  ) as { x?: unknown; y?: unknown } | undefined;
  return {
    x: typeof converted?.x === "number" ? converted.x : 0,
    y: typeof converted?.y === "number" ? converted.y : 0,
  };
};

export const createViewportCapability = (getApi: () => ViewportApi | null): ViewportCapability => {
  const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
    if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
    return result;
  };
  const notReady = <T>(seam: string): CapabilityResult<T> =>
    report(fail("not-ready", seam, { detail: "the editor handle is not attached" }));

  return {
    read() {
      const api = getApi();
      if (!api) return notReady("viewport.read");
      return ok(readViewport(api.getAppState()));
    },

    visibleBounds() {
      const api = getApi();
      if (!api) return notReady("viewport.visibleBounds");
      const bounds = parseBounds(getVisibleSceneBounds(api.getAppState() as never));
      if (!bounds) {
        return report(
          fail("editor-changed", "viewport.visibleBounds", {
            detail: "getVisibleSceneBounds no longer returns four finite numbers",
          }),
        );
      }
      return ok(bounds);
    },

    showBounds(bounds) {
      const api = getApi();
      if (!api) return notReady<AppliedViewport>("viewport.showBounds");

      const before = api.getAppState();
      const clamped = wouldClampZoom(before, bounds);

      const fitted = zoomToFitBounds({
        appState: before as never,
        bounds: bounds as never,
        fitToViewport: true,
        viewportZoomFactor: 1,
      })?.appState as Record<string, unknown> | undefined;

      if (!fitted) {
        return report(
          fail("editor-changed", "viewport.showBounds", {
            detail: "zoomToFitBounds no longer returns an app state",
          }),
        );
      }

      api.updateScene({ appState: fitted });

      const applied = { ...before, ...fitted };
      const shown = parseBounds(getVisibleSceneBounds(applied as never));
      return ok({
        viewport: readViewport(applied),
        bounds: shown ?? bounds,
        zoomClamped: clamped,
      });
    },

    scrollToElement(id: ElementId) {
      const api = getApi();
      if (!api) return notReady<AppliedViewport>("viewport.scrollToElement");
      const element = (api.getSceneElements() as Record<string, unknown>[]).find(
        (candidate) => candidate.id === id,
      );
      if (!element) {
        return report(
          fail("invalid-state", "viewport.scrollToElement", {
            detail: "no such element in the scene",
          }),
        );
      }
      const x = num(element.x, 0);
      const y = num(element.y, 0);
      return this.showBounds([
        x,
        y,
        x + num(element.width, 0),
        y + num(element.height, 0),
      ] as SceneBounds);
    },

    toViewport(point: ScenePoint) {
      const api = getApi();
      if (!api) return notReady<ViewportPoint>("viewport.toViewport");
      const converted = sceneCoordsToViewportCoords(
        { sceneX: point.x, sceneY: point.y } as never,
        api.getAppState() as never,
      ) as { x?: unknown; y?: unknown } | undefined;
      if (!converted || typeof converted.x !== "number" || typeof converted.y !== "number") {
        return report(
          fail("editor-changed", "viewport.toViewport", {
            detail: "sceneCoordsToViewportCoords no longer returns a point",
          }),
        );
      }
      return ok({ x: converted.x, y: converted.y });
    },

    toScene(point: ViewportPoint) {
      const api = getApi();
      if (!api) return notReady<ScenePoint>("viewport.toScene");
      const state = readViewport(api.getAppState());
      // The inverse of the editor's own transform, written out rather than
      // imported: viewportCoordsToSceneCoords takes an app state shape this
      // layer would otherwise have to fabricate.
      return ok({
        x: (point.x - state.offsetLeft) / state.zoom - state.scrollX,
        y: (point.y - state.offsetTop) / state.zoom - state.scrollY,
      });
    },

    subscribeScroll(listener) {
      const api = getApi();
      if (!api?.onScrollChange) return () => {};
      return api.onScrollChange(() => listener(readViewport(api.getAppState())));
    },
  };
};
