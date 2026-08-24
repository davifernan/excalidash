import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { listFrames, useFrameNavigator } from "./frameNavigator";

const summary = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0,
  isDeleted: false,
  frameId: null,
  containerId: null,
  link: null,
  customData: null,
  name: null,
  ...over,
});

describe("listFrames", () => {
  it("returns nothing when the read fails", () => {
    const scene = { summaries: vi.fn(() => ({ ok: false, error: { seam: "x", code: "y" } })) };
    expect(listFrames(scene as never)).toEqual([]);
  });

  it("filters to frame/magicframe elements only, skipping deleted ones", () => {
    const scene = {
      summaries: vi.fn(() => ({
        ok: true,
        value: [
          summary({ id: "rect-1", type: "rectangle" }),
          summary({
            id: "frame-1",
            type: "frame",
            name: "Ideas",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
          }),
          summary({ id: "frame-2", type: "frame", name: "Deleted", isDeleted: true }),
          summary({ id: "mframe-1", type: "magicframe", name: "AI stuff", width: 20, height: 20 }),
        ],
      })),
    };
    const frames = listFrames(scene as never);
    expect(frames.map((f) => f.id)).toEqual(["frame-1", "mframe-1"]);
    expect(frames[0]).toEqual({ id: "frame-1", name: "Ideas", bounds: [0, 0, 100, 50] });
  });

  it("falls back to a numbered name for an unnamed frame", () => {
    const scene = {
      summaries: vi.fn(() => ({
        ok: true,
        value: [summary({ id: "frame-1", type: "frame", name: "" })],
      })),
    };
    expect(listFrames(scene as never)[0].name).toBe("Frame 1");
  });

  it("preserves document order", () => {
    const scene = {
      summaries: vi.fn(() => ({
        ok: true,
        value: [
          summary({ id: "frame-b", type: "frame", name: "B" }),
          summary({ id: "frame-a", type: "frame", name: "A" }),
        ],
      })),
    };
    expect(listFrames(scene as never).map((f) => f.name)).toEqual(["B", "A"]);
  });
});

describe("useFrameNavigator", () => {
  /**
   * Mirrors `createSceneCapability.subscribe`'s real behaviour exactly: the
   * Excalidraw handle "arrives late", so a subscribe call made before it
   * exists returns a no-op unsubscribe and registers nothing (see
   * `integrations/excalidraw/index.ts`'s file comment). This is the mock that
   * would have caught the real bug this hook shipped with once already: it
   * subscribed once at mount, before the handle existed, and never picked up
   * a template's frames inserted afterwards.
   */
  const makeLateScene = () => {
    let apiReady = false;
    let value: unknown[] = [];
    let listener: (() => void) | null = null;
    return {
      becomeReady: () => {
        apiReady = true;
      },
      setFrames: (frames: unknown[]) => {
        value = frames;
        listener?.();
      },
      capability: {
        summaries: vi.fn(() => (apiReady ? { ok: true, value } : { ok: false, error: {} })),
        subscribe: vi.fn((cb: () => void) => {
          if (!apiReady) return () => {};
          listener = cb;
          return () => {
            listener = null;
          };
        }),
      },
    };
  };

  it("does not subscribe before the Excalidraw handle is ready", () => {
    const late = makeLateScene();
    renderHook(({ ready }) => useFrameNavigator(late.capability as never, ready), {
      initialProps: { ready: false },
    });
    expect(late.capability.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes once isReady flips true, and picks up frames inserted after that", () => {
    const late = makeLateScene();
    const { result, rerender } = renderHook(
      ({ ready }) => useFrameNavigator(late.capability as never, ready),
      { initialProps: { ready: false } },
    );
    expect(result.current).toEqual([]);

    late.becomeReady();
    rerender({ ready: true });
    expect(late.capability.subscribe).toHaveBeenCalledTimes(1);

    act(() => {
      late.setFrames([summary({ id: "frame-1", type: "frame", name: "Ideas" })]);
    });
    expect(result.current.map((f) => f.name)).toEqual(["Ideas"]);
  });
});
