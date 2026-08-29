import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { describe, expect, it, vi } from "vitest";
import { createBoundArrow } from "./boundArrow";
import { buildElements } from "./elements";

vi.hoisted(() => {
  class TestPath2D {}
  (globalThis as Record<string, unknown>).Path2D = TestPath2D;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn(), has: vi.fn(() => true), check: vi.fn(() => true) },
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    const context = { canvas: this, filter: "none", font: "", measureText: () => ({ width: 1 }) };
    return new Proxy(context, {
      get(target, property) {
        return property in target ? target[property as keyof typeof target] : vi.fn();
      },
      set(target, property, value) {
        (target as Record<PropertyKey, unknown>)[property] = value;
        return true;
      },
    });
  }) as never;
});

describe("bound elbow arrows", () => {
  it("remain orthogonal in the rendered Excalidraw editor", async () => {
    let api: any;
    const view = render(
      <div style={{ width: 900, height: 600 }}>
        <Excalidraw
          excalidrawAPI={(value) => {
            api = value;
          }}
        />
      </div>,
    );
    await waitFor(() => expect(api).toBeDefined());
    const [start, end] = buildElements(
      [
        { id: "start", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "end", type: "rectangle", x: 400, y: 300, width: 200, height: 100 },
      ],
      { regenerateIds: false },
    ) as any[];
    const arrow = createBoundArrow(
      "arrow",
      start,
      end,
      { x: 200, y: 50 },
      { x: 400, y: 350 },
      { strokeColor: "#1b1b1f", strokeWidth: 2, elbowed: true },
    );

    await act(async () => api.updateScene({ elements: [start, end, arrow] }));
    await waitFor(() => {
      const routed = api.getSceneElements().find((element: any) => element.id === arrow.id);
      expect(routed.points).toHaveLength(3);
      expect(
        routed.points.slice(1).every((point: number[], index: number) => {
          const previous = routed.points[index];
          return point[0] === previous[0] || point[1] === previous[1];
        }),
      ).toBe(true);
    });
    view.unmount();
  });
});
