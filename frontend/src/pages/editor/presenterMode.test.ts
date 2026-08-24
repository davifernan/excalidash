import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindPresenterMode,
  createIdlePresenterSnapshot,
  parsePresenterSnapshot,
  PRESENTER_COMMAND_EVENT,
  PRESENTER_NOTES_SET_EVENT,
  PRESENTER_STATE_EVENT,
  PRESENTER_VIEWPORT_EVENT,
} from "./presenterMode";

const makeSocket = (id = "me") => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    id,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => handlers.set(event, handler)),
    off: vi.fn(),
    trigger: (event: string, payload: unknown) => handlers.get(event)?.(payload),
  };
};

const makeViewport = () => ({
  subscribeScroll: vi.fn((_listener: () => void) => () => {}),
  visibleBounds: vi.fn(() => ({ ok: true as const, value: [0, 0, 100, 100] as const })),
  showBounds: vi.fn(() => ({ ok: true as const, value: {} as never })),
});

describe("parsePresenterSnapshot", () => {
  it("accepts the idle shape for the right drawing", () => {
    expect(parsePresenterSnapshot({ drawingId: "d1", status: "idle" }, "d1")).toEqual(
      createIdlePresenterSnapshot("d1"),
    );
  });

  it("rejects a snapshot for another drawing", () => {
    expect(parsePresenterSnapshot({ drawingId: "d2", status: "idle" }, "d1")).toBeNull();
  });

  it("rejects a presenting snapshot without a presenter id", () => {
    expect(parsePresenterSnapshot({ drawingId: "d1", status: "presenting" }, "d1")).toBeNull();
  });

  it("accepts a full presenting snapshot", () => {
    const snapshot = parsePresenterSnapshot(
      {
        drawingId: "d1",
        status: "presenting",
        presenterPresenceId: "them",
        presenterName: "Ada",
        frameId: "frame-1",
        bounds: [0, 0, 10, 10],
        revision: 3,
      },
      "d1",
    );
    expect(snapshot).toEqual({
      drawingId: "d1",
      status: "presenting",
      presenterPresenceId: "them",
      presenterName: "Ada",
      frameId: "frame-1",
      bounds: [0, 0, 10, 10],
      revision: 3,
    });
  });

  it("rejects malformed bounds instead of silently dropping to null", () => {
    expect(
      parsePresenterSnapshot(
        { drawingId: "d1", status: "presenting", presenterPresenceId: "them", bounds: ["x"] },
        "d1",
      ),
    ).toBeNull();
  });
});

describe("bindPresenterMode", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("moves the local viewport for an incoming presenter broadcast while following", () => {
    const socket = makeSocket("audience-1");
    const viewport = makeViewport();
    const onStateChange = vi.fn();
    bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport,
      onStateChange,
      onNotesChange: vi.fn(),
    });

    socket.trigger(PRESENTER_STATE_EVENT, {
      drawingId: "d1",
      status: "presenting",
      presenterPresenceId: "presenter-1",
      presenterName: "Ada",
      frameId: "frame-1",
      bounds: [0, 0, 20, 20],
      revision: 1,
    });

    expect(viewport.showBounds).toHaveBeenCalledWith([0, 0, 20, 20]);
    expect(onStateChange).toHaveBeenCalled();
  });

  it("never moves the viewport for the presenter's own broadcast", () => {
    const socket = makeSocket("presenter-1");
    const viewport = makeViewport();
    bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport,
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });

    socket.trigger(PRESENTER_STATE_EVENT, {
      drawingId: "d1",
      status: "presenting",
      presenterPresenceId: "presenter-1",
      bounds: [0, 0, 20, 20],
      revision: 1,
    });

    expect(viewport.showBounds).not.toHaveBeenCalled();
  });

  it("stops moving the viewport once the audience member turns following off", () => {
    const socket = makeSocket("audience-1");
    const viewport = makeViewport();
    const controller = bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport,
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });
    controller.setFollowing(false);

    socket.trigger(PRESENTER_STATE_EVENT, {
      drawingId: "d1",
      status: "presenting",
      presenterPresenceId: "presenter-1",
      bounds: [0, 0, 20, 20],
      revision: 1,
    });

    expect(viewport.showBounds).not.toHaveBeenCalled();
    expect(controller.isFollowing()).toBe(false);
  });

  it("jumpToFrame reports the frame once, immediately, not throttled", () => {
    const socket = makeSocket("presenter-1");
    const controller = bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport: makeViewport(),
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });

    controller.jumpToFrame("frame-2", [1, 2, 3, 4]);

    expect(socket.emit).toHaveBeenCalledWith(PRESENTER_VIEWPORT_EVENT, {
      drawingId: "d1",
      frameId: "frame-2",
      sceneBounds: [1, 2, 3, 4],
    });
  });

  it("only sends a viewport update from a scroll change while self-presenting", () => {
    vi.useFakeTimers();
    const socket = makeSocket("presenter-1");
    let scrollListener: (() => void) | null = null;
    const viewport = {
      ...makeViewport(),
      subscribeScroll: vi.fn((listener: () => void) => {
        scrollListener = listener;
        return () => {};
      }),
    };
    bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport,
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });

    // Not presenting yet: a scroll must not emit anything.
    scrollListener?.();
    vi.advanceTimersByTime(100);
    expect(socket.emit).not.toHaveBeenCalledWith(PRESENTER_VIEWPORT_EVENT, expect.anything());

    socket.trigger(PRESENTER_STATE_EVENT, {
      drawingId: "d1",
      status: "presenting",
      presenterPresenceId: "presenter-1",
      revision: 1,
    });
    scrollListener?.();
    vi.advanceTimersByTime(100);
    expect(socket.emit).toHaveBeenCalledWith(
      PRESENTER_VIEWPORT_EVENT,
      expect.objectContaining({ drawingId: "d1", frameId: null }),
    );
  });

  it("sends start/stop/takeover as acked commands and resolves the outcome", async () => {
    const socket = makeSocket("presenter-1");
    (socket.emit as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _payload: unknown, ack?: (value: unknown) => void) => ack?.({ ok: true }),
    );
    const controller = bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport: makeViewport(),
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });

    await expect(controller.start()).resolves.toEqual({ ok: true });
    expect(socket.emit).toHaveBeenCalledWith(
      PRESENTER_COMMAND_EVENT,
      { drawingId: "d1", action: "start" },
      expect.any(Function),
    );
    await expect(controller.stop()).resolves.toEqual({ ok: true });
    await expect(controller.takeover()).resolves.toEqual({ ok: true });
  });

  it("resolves a rejected command with the server's error", async () => {
    const socket = makeSocket("presenter-1");
    (socket.emit as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _payload: unknown, ack?: (value: unknown) => void) =>
        ack?.({ ok: false, error: { code: "presenter-active", message: "taken" } }),
    );
    const controller = bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport: makeViewport(),
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });

    await expect(controller.start()).resolves.toEqual({
      ok: false,
      error: { code: "presenter-active", message: "taken" },
    });
  });

  it("forwards notes writes with the current frame id", () => {
    const socket = makeSocket("presenter-1");
    const controller = bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport: makeViewport(),
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });

    controller.setNotes("frame-1", "Ask about budget");

    expect(socket.emit).toHaveBeenCalledWith(PRESENTER_NOTES_SET_EVENT, {
      drawingId: "d1",
      frameId: "frame-1",
      text: "Ask about budget",
    });
  });

  it("dispose unsubscribes from both socket events", () => {
    const socket = makeSocket("presenter-1");
    const controller = bindPresenterMode({
      socket: socket as never,
      drawingId: "d1",
      viewport: makeViewport(),
      onStateChange: vi.fn(),
      onNotesChange: vi.fn(),
    });
    controller.dispose();
    expect(socket.off).toHaveBeenCalledWith(PRESENTER_STATE_EVENT, expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith(
      expect.stringContaining("presenter-notes"),
      expect.any(Function),
    );
  });
});
