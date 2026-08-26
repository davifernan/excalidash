import { beforeEach, describe, expect, it, vi } from "vitest";

const excalidrawMocks = vi.hoisted(() => ({
  getVisibleSceneBounds: vi.fn(() => [-50, -25, 450, 275]),
  sceneCoordsToViewportCoords: vi.fn(
    ({ sceneX, sceneY }: { sceneX: number; sceneY: number }, appState: any) => ({
      x: (sceneX + appState.scrollX) * appState.zoom.value + appState.offsetLeft,
      y: (sceneY + appState.scrollY) * appState.zoom.value + appState.offsetTop,
    }),
  ),
  zoomToFitBounds: vi.fn(() => ({
    appState: { scrollX: 0, scrollY: 100, zoom: { value: 2 } },
  })),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  getVisibleSceneBounds: excalidrawMocks.getVisibleSceneBounds,
  sceneCoordsToViewportCoords: excalidrawMocks.sceneCoordsToViewportCoords,
  zoomToFitBounds: excalidrawMocks.zoomToFitBounds,
}));

import { bindFollowMode, getFollowInterruptionMessage, parseFollowSceneBounds } from "./followMode";
import { stacking } from "../../integrations/excalidraw/stacking";

describe("getFollowInterruptionMessage", () => {
  it("names the mutual-follow and self-follow cases instead of a generic fallback", () => {
    expect(getFollowInterruptionMessage("cycle-detected")).toBe(
      "You can't follow someone who is already following you.",
    );
    expect(getFollowInterruptionMessage("self-follow")).toBe("You can't follow yourself.");
    expect(getFollowInterruptionMessage("queue-full")).toBe(
      "Too many follow commands at once; try again in a moment.",
    );
    expect(getFollowInterruptionMessage("something-unmapped")).toBe(
      "Follow mode ended on the server.",
    );
  });
});

describe("follow viewport bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts only finite, ordered scene rectangles", () => {
    expect(parseFollowSceneBounds([-10, -20, 300, 400])).toEqual([-10, -20, 300, 400]);
    expect(parseFollowSceneBounds([0, 0, Number.NaN, 10])).toBeNull();
    expect(parseFollowSceneBounds([0, 0, 0, 10])).toBeNull();
    expect(parseFollowSceneBounds([0, 0, 10])).toBeNull();
  });

  it("binds the imperative follow API and relays bounds only for followers", () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (payload: any) => void>();
    const socket = {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (payload: any) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
    };
    let followCallback: (payload: any) => void = () => undefined;
    let scrollCallback: () => void = () => undefined;
    const state: any = {
      width: 1000,
      height: 600,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      userToFollow: { socketId: "target-socket" },
      followedBy: new Set(),
    };
    const api = {
      getAppState: () => state,
      updateScene: vi.fn(),
      onUserFollow: vi.fn((callback: (payload: any) => void) => {
        followCallback = callback;
        return vi.fn();
      }),
      onScrollChange: vi.fn((callback: () => void) => {
        scrollCallback = callback;
        return vi.fn();
      }),
    };
    const onFollowersChange = vi.fn();
    const onFollowInterrupted = vi.fn();
    const cleanup = bindFollowMode({
      socket: socket as any,
      drawingId: "drawing-1",
      api,
      container: null,
      onFollowersChange,
      onFollowInterrupted,
    });

    followCallback({
      action: "FOLLOW",
      userToFollow: { socketId: "target-socket" },
    });
    expect(socket.emit).toHaveBeenCalledWith("follow-user", {
      drawingId: "drawing-1",
      targetPresenceId: "target-socket",
      action: "FOLLOW",
    });

    scrollCallback();
    vi.advanceTimersByTime(50);
    expect(socket.emit).toHaveBeenCalledTimes(1);

    handlers.get("followed-by-update")?.({
      drawingId: "drawing-1",
      followers: [{ presenceId: "follower-socket", name: "Follower" }],
    });
    expect(onFollowersChange).toHaveBeenCalledWith([
      { presenceId: "follower-socket", name: "Follower" },
    ]);
    expect(socket.emit).toHaveBeenLastCalledWith("viewport-bounds", {
      drawingId: "drawing-1",
      sceneBounds: [-50, -25, 450, 275],
    });

    scrollCallback();
    vi.advanceTimersByTime(50);
    expect(socket.emit).toHaveBeenLastCalledWith("viewport-bounds", {
      drawingId: "drawing-1",
      sceneBounds: [-50, -25, 450, 275],
    });

    handlers.get("follow-status")?.({
      drawingId: "drawing-1",
      followingPresenceId: null,
      reason: "target-unavailable",
    });
    expect(api.updateScene).toHaveBeenLastCalledWith({
      appState: { userToFollow: null },
    });
    expect(onFollowInterrupted).toHaveBeenCalledWith("target-unavailable");

    cleanup();
    vi.useRealTimers();
  });

  it("keeps the indicator below controls, reapplies it on resize, and marks zoom clamps", () => {
    vi.useFakeTimers();
    let resizeCallback = () => undefined;
    const disconnectResize = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {
          disconnectResize();
        }
      },
    );
    const handlers = new Map<string, (payload: any) => void>();
    const socket = {
      emit: vi.fn(),
      on: (event: string, handler: (payload: any) => void) => handlers.set(event, handler),
      off: vi.fn(),
    };
    let scrollCallback = () => undefined;
    const state: any = {
      width: 2000,
      height: 500,
      offsetLeft: 0,
      offsetTop: 0,
      scrollX: 1500,
      scrollY: 0,
      zoom: { value: 0.5 },
      userToFollow: { socketId: "target-socket" },
      followedBy: new Set(["own-follower"]),
      collaborators: new Map(),
    };
    const updateScene = vi.fn(({ appState }: any) => {
      Object.assign(state, appState);
      if (appState.zoom) scrollCallback();
    });
    excalidrawMocks.zoomToFitBounds.mockReturnValue({
      appState: { scrollX: 1500, scrollY: 0, zoom: { value: 0.5 } },
    });
    const api = {
      getAppState: () => state,
      updateScene,
      onUserFollow: () => vi.fn(),
      onScrollChange: (callback: () => void) => {
        scrollCallback = callback;
        return vi.fn();
      },
    };
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 2000, height: 500 }) as DOMRect;
    document.body.append(container);
    const cleanup = bindFollowMode({
      socket: socket as any,
      drawingId: "drawing-1",
      api,
      container,
      onFollowersChange: vi.fn(),
    });
    handlers.get("viewport-bounds")?.({
      drawingId: "drawing-1",
      presenceId: "target-socket",
      sceneBounds: [0, 0, 1000, 1000],
      sequence: 1,
    });

    const frame = container.querySelector<HTMLElement>('[data-follow-viewport="frame"]');
    const control = document.createElement("button");
    control.style.position = "absolute";
    control.style.zIndex = stacking.chrome;
    container.append(control);
    expect(frame?.style.width).toBe("500px");
    expect(frame?.style.height).toBe("500px");
    expect(frame?.style.boxShadow).toContain("9999px");
    expect(frame?.style.zIndex).toBe(stacking.elementOverlay);
    expect(control.style.zIndex).toBe(stacking.chrome);
    expect(socket.emit).not.toHaveBeenCalledWith("viewport-bounds", expect.anything());

    resizeCallback();
    expect(excalidrawMocks.zoomToFitBounds).toHaveBeenCalledTimes(2);

    state.width = 100;
    state.height = 100;
    excalidrawMocks.zoomToFitBounds.mockReturnValue({
      appState: { scrollX: 0, scrollY: 0, zoom: { value: 0.1 } },
    });
    handlers.get("viewport-bounds")?.({
      drawingId: "drawing-1",
      presenceId: "target-socket",
      sceneBounds: [0, 0, 2000, 2000],
      sequence: 2,
    });
    expect(
      container.querySelector<HTMLElement>('[data-follow-viewport="zoom-warning"]')?.style.display,
    ).toBe("block");

    cleanup();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
