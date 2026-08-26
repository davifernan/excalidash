import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ filter: "none" })) as any;
});

import { getVisibleSceneBounds, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import { createViewportCapability } from "../../integrations/excalidraw/viewport";
import { fitFollowedBounds } from "./followMode";

const appState = (width: number, height: number) => ({
  width,
  height,
  offsetLeft: 0,
  offsetTop: 0,
  scrollX: 0,
  scrollY: 0,
  zoom: { value: 1 },
});

describe("follow viewport geometry with Excalidraw", () => {
  it.each([
    { width: 1_600, height: 520, expectedZoom: 0.5 },
    { width: 760, height: 900, expectedZoom: 1 },
  ])(
    "centers the complete target at the exact supported scale in $width x $height",
    ({ width, height, expectedZoom }) => {
      const targetBounds = [120, -80, 880, 820] as const;
      const targetWidth = targetBounds[2] - targetBounds[0];
      const targetHeight = targetBounds[3] - targetBounds[1];
      let state: any = appState(width, height);
      const api = {
        getAppState: () => state,
        updateScene: vi.fn(({ appState: update }: any) => {
          state = { ...state, ...update };
        }),
      };

      const viewport = createViewportCapability(() => ({ ...api, getSceneElements: () => [] }));
      const fitted = fitFollowedBounds(viewport, targetBounds as any);
      expect(fitted).not.toBeNull();
      if (!fitted) return;
      const fittedAppState = {
        ...state,
        ...fitted.viewport,
        zoom: { value: fitted.viewport.zoom },
      };
      const visible = getVisibleSceneBounds(fittedAppState);

      expect(fittedAppState.zoom.value).toBe(expectedZoom);
      expect((visible[0] + visible[2]) / 2).toBeCloseTo((targetBounds[0] + targetBounds[2]) / 2, 8);
      expect((visible[1] + visible[3]) / 2).toBeCloseTo((targetBounds[1] + targetBounds[3]) / 2, 8);
      expect(visible[2] - visible[0]).toBeCloseTo(width / expectedZoom, 8);
      expect(visible[3] - visible[1]).toBeCloseTo(height / expectedZoom, 8);

      const topLeft = sceneCoordsToViewportCoords(
        { sceneX: targetBounds[0], sceneY: targetBounds[1] },
        fittedAppState,
      );
      const bottomRight = sceneCoordsToViewportCoords(
        { sceneX: targetBounds[2], sceneY: targetBounds[3] },
        fittedAppState,
      );
      const projectedWidth = targetWidth * expectedZoom;
      const projectedHeight = targetHeight * expectedZoom;
      expect(topLeft.x).toBeCloseTo((width - projectedWidth) / 2, 8);
      expect(topLeft.y).toBeCloseTo((height - projectedHeight) / 2, 8);
      expect(bottomRight.x).toBeCloseTo((width + projectedWidth) / 2, 8);
      expect(bottomRight.y).toBeCloseTo((height + projectedHeight) / 2, 8);
    },
  );
});
