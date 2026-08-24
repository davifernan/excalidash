import { beforeEach, describe, expect, it, vi } from "vitest";

const excalidrawMocks = vi.hoisted(() => ({
  getVisibleSceneBounds: vi.fn(() => [-50, -25, 450, 275]),
  zoomToFitBounds: vi.fn(() => ({
    appState: { scrollX: 0, scrollY: 100, zoom: { value: 2 } },
  })),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  getVisibleSceneBounds: excalidrawMocks.getVisibleSceneBounds,
  sceneCoordsToViewportCoords: vi.fn(),
  zoomToFitBounds: excalidrawMocks.zoomToFitBounds,
}));

import { createViewportCapability } from "../../integrations/excalidraw/viewport";
import { bindInviteHere, boundsOverlap, isAlreadyThere } from "./inviteHere";

const setup = () => {
  const handlers = new Map<string, (payload: any) => void>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (payload: any) => void) => handlers.set(event, handler)),
    off: vi.fn(),
  };
  const state = {
    width: 1000,
    height: 600,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    userToFollow: null,
  };
  const api = {
    getAppState: () => state,
    updateScene: vi.fn(),
    getSceneElements: () => [],
  };
  // The real viewport capability over a stand-in editor, rather than a stand-in
  // capability: a mock here would prove only that the mock was called.
  const viewport = createViewportCapability(() => api);
  const onInvitationChange = vi.fn();
  const onStatusChange = vi.fn();
  const onAlreadyThere = vi.fn();
  const controller = bindInviteHere({
    socket: socket as any,
    drawingId: "drawing-1",
    viewport,
    onInvitationChange,
    onStatusChange,
    onAlreadyThere,
  });
  const receive = (invitationId: string, sceneBounds = [0, 0, 100, 100]) =>
    handlers.get("invite-here")?.({
      drawingId: "drawing-1",
      invitationId,
      inviterName: "Inviter",
      sceneBounds,
      expiresAt: Date.now() + 15_000,
    });
  return { api, controller, handlers, onAlreadyThere, onInvitationChange, socket, state, receive };
};

describe("invite here client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T10:00:00Z"));
    vi.clearAllMocks();
  });

  it("automatically expires the invitation after fifteen seconds", () => {
    const { controller, onInvitationChange, receive } = setup();
    receive("invite-a");

    vi.advanceTimersByTime(14_999);
    expect(onInvitationChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onInvitationChange).toHaveBeenLastCalledWith(null);

    controller.dispose();
    vi.useRealTimers();
  });

  it("replaces a running invitation instead of stacking it", () => {
    const { controller, onInvitationChange, receive } = setup();
    receive("invite-a", [0, 0, 100, 100]);
    vi.advanceTimersByTime(1_000);
    receive("invite-b", [200, 300, 600, 700]);

    const visibleInvitations = onInvitationChange.mock.calls
      .map(([invitation]) => invitation)
      .filter(Boolean);
    expect(visibleInvitations.map((invitation) => invitation.invitationId)).toEqual([
      "invite-a",
      "invite-b",
    ]);
    vi.advanceTimersByTime(14_000);
    expect(onInvitationChange).not.toHaveBeenLastCalledWith(null);
    vi.advanceTimersByTime(1_000);
    expect(onInvitationChange).toHaveBeenLastCalledWith(null);

    controller.dispose();
    vi.useRealTimers();
  });

  it("accepts once, fits once, and never enables follow mode", () => {
    const { api, controller, socket, state, receive } = setup();
    receive("invite-a", [-100, -50, 500, 350]);

    controller.accept();
    controller.accept();

    expect(excalidrawMocks.zoomToFitBounds).toHaveBeenCalledTimes(1);
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith("invite-here-response", {
      drawingId: "drawing-1",
      invitationId: "invite-a",
      decision: "accepted",
    });
    expect(state.userToFollow).toBeNull();

    controller.dispose();
    vi.useRealTimers();
  });

  it("does not jump, but still counts the accept, when the view is already the same", () => {
    // The mocked own view is [-50, -25, 450, 275] (getVisibleSceneBounds
    // above). An invitation to almost exactly that rectangle is the "already
    // there" case this test targets.
    const { api, controller, onAlreadyThere, socket, receive } = setup();
    receive("invite-a", [-48, -24, 448, 274]);

    controller.accept();

    expect(onAlreadyThere).toHaveBeenCalledTimes(1);
    expect(excalidrawMocks.zoomToFitBounds).not.toHaveBeenCalled();
    expect(api.updateScene).not.toHaveBeenCalled();
    // The accept still has to reach the inviter -- "already there" is
    // feedback about the jump, not a silent decline.
    expect(socket.emit).toHaveBeenCalledWith("invite-here-response", {
      drawingId: "drawing-1",
      invitationId: "invite-a",
      decision: "accepted",
    });

    controller.dispose();
    vi.useRealTimers();
  });
});

describe("boundsOverlap / isAlreadyThere", () => {
  it("is 1 for identical rectangles and 0 for rectangles that do not touch", () => {
    expect(boundsOverlap([0, 0, 100, 100], [0, 0, 100, 100])).toBe(1);
    expect(boundsOverlap([0, 0, 100, 100], [200, 200, 300, 300])).toBe(0);
  });

  it("treats a small, ordinary difference in two viewports as the same place", () => {
    expect(isAlreadyThere([-50, -25, 450, 275], [-48, -24, 448, 274])).toBe(true);
  });

  it("treats a different part of the same board as a different place", () => {
    expect(isAlreadyThere([-50, -25, 450, 275], [-100, -50, 500, 350])).toBe(false);
    expect(isAlreadyThere([0, 0, 100, 100], [1000, 1000, 1100, 1100])).toBe(false);
  });
});
