import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindSocketCollaborators } from "./socketCollaborators";

const IDLE_HOLD_MS = 5_000;
const IDLE_EXPIRE_MS = 30_000;
const IDLE_COLOR = "#94a3b8";

class FakeSocket {
  id = "self";
  private handlers = new Map<string, (payload: any) => void>();

  on(event: string, handler: (payload: any) => void) {
    this.handlers.set(event, handler);
  }

  off(event: string, handler: (payload: any) => void) {
    if (this.handlers.get(event) === handler) this.handlers.delete(event);
  }

  trigger(event: string, payload: any) {
    this.handlers.get(event)?.(payload);
  }
}

const peer = (isActive: boolean) => ({
  presenceId: "peer",
  name: "Peer",
  initials: "P",
  color: "#123456",
  isActive,
});

const createHarness = () => {
  const socket = new FakeSocket();
  let collaborators = new Map<string, any>();
  const peerSnapshots: any[][] = [];
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  let frameNow = 0;

  vi.spyOn(performance, "now").mockImplementation(() => frameNow);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      frames.delete(id);
    }),
  );

  const api = {
    getAppState: () => ({ collaborators }),
    updateScene: vi.fn((scene: any) => {
      collaborators = scene.collaborators;
    }),
  };
  const binding = bindSocketCollaborators({
    socket: socket as any,
    api,
    onPeersChange: (peers) => peerSnapshots.push(peers),
  });

  return {
    socket,
    binding,
    peerSnapshots,
    collaborators: () => collaborators,
    runFrame(atMs: number) {
      frameNow = atMs;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(atMs));
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-22T20:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("inactive collaborator lifecycle", () => {
  it("holds the last cursor, dims it, then hides it without ending map membership", () => {
    const harness = createHarness();
    harness.socket.trigger("presence-update", [peer(true)]);
    harness.socket.trigger("cursor-move", {
      presenceId: "peer",
      pointer: { x: 20, y: 40, tool: "pointer" },
      username: "Peer",
      color: "#123456",
    });
    harness.runFrame(0);

    harness.socket.trigger("presence-update", [peer(false)]);
    expect(harness.collaborators().get("peer")?.pointer).toEqual({
      x: 20,
      y: 40,
      tool: "pointer",
    });
    expect(harness.collaborators().get("peer")?.color.background).toBe("#123456");

    vi.advanceTimersByTime(IDLE_HOLD_MS);
    expect(harness.collaborators().get("peer")?.color).toEqual({
      background: IDLE_COLOR,
      stroke: IDLE_COLOR,
    });
    expect(harness.collaborators().get("peer")?.userState).toBe("away");
    expect(harness.collaborators().get("peer")?.avatarUrl).toContain(
      "data:image/svg+xml;charset=utf-8",
    );
    expect(harness.peerSnapshots.at(-1)?.map((entry) => entry.presenceId)).toEqual(["peer"]);

    vi.advanceTimersByTime(IDLE_EXPIRE_MS - IDLE_HOLD_MS);
    expect(harness.collaborators().has("peer")).toBe(true);
    expect(harness.collaborators().get("peer")?.username).toBe("");
    expect(harness.collaborators().get("peer")?.pointer).toMatchObject({
      x: 20,
      y: 40,
      renderCursor: false,
    });
    expect(harness.peerSnapshots.at(-1)).toEqual([]);
    harness.binding.dispose();
  });

  it("restores an inactive peer that returns before expiry and cancels stale removal", () => {
    const harness = createHarness();
    harness.socket.trigger("presence-update", [peer(true)]);
    harness.socket.trigger("presence-update", [peer(false)]);
    vi.advanceTimersByTime(IDLE_HOLD_MS);
    expect(harness.collaborators().get("peer")?.color.background).toBe(IDLE_COLOR);

    harness.socket.trigger("presence-update", [peer(true)]);
    expect(harness.collaborators().get("peer")?.color.background).toBe("#123456");
    expect(harness.collaborators().get("peer")?.isActive).toBe(true);
    expect(harness.collaborators().get("peer")?.userState).toBeUndefined();
    expect(harness.collaborators().get("peer")?.avatarUrl).toBeUndefined();

    vi.advanceTimersByTime(IDLE_EXPIRE_MS);
    expect(harness.collaborators().has("peer")).toBe(true);
    harness.binding.dispose();
  });

  it("escapes a user-controlled initial in the dimmed avatar SVG", () => {
    const harness = createHarness();
    const unsafePeer = { ...peer(true), name: "<script" };
    harness.socket.trigger("presence-update", [unsafePeer]);
    harness.socket.trigger("presence-update", [{ ...unsafePeer, isActive: false }]);
    vi.advanceTimersByTime(IDLE_HOLD_MS);

    const avatarUrl = harness.collaborators().get("peer")?.avatarUrl;
    expect(decodeURIComponent(avatarUrl)).toContain(">&lt;</text>");
    expect(decodeURIComponent(avatarUrl)).not.toContain("<script");
    harness.binding.dispose();
  });

  it("removes a real departure immediately during the grace period", () => {
    const harness = createHarness();
    harness.socket.trigger("presence-update", [peer(true)]);
    harness.socket.trigger("presence-update", [peer(false)]);
    expect(harness.collaborators().has("peer")).toBe(true);

    harness.socket.trigger("presence-update", []);
    expect(harness.collaborators().has("peer")).toBe(false);
    expect(harness.peerSnapshots.at(-1)).toEqual([]);
    harness.binding.dispose();
  });

  it("restores a visually expired peer without a cursor jump", () => {
    const harness = createHarness();
    harness.socket.trigger("presence-update", [peer(true)]);
    harness.socket.trigger("cursor-move", {
      presenceId: "peer",
      pointer: { x: 45, y: 60, tool: "pointer" },
      username: "Peer",
      color: "#123456",
    });
    harness.runFrame(0);
    harness.socket.trigger("presence-update", [peer(false)]);
    vi.advanceTimersByTime(IDLE_EXPIRE_MS);
    expect(harness.collaborators().get("peer")?.pointer.renderCursor).toBe(false);

    harness.socket.trigger("presence-update", [peer(true)]);
    expect(harness.collaborators().get("peer")?.username).toBe("Peer");
    expect(harness.collaborators().get("peer")?.pointer).toMatchObject({ x: 45, y: 60 });
    expect(harness.collaborators().get("peer")?.pointer.renderCursor).toBeUndefined();
    harness.binding.dispose();
  });

  it("does not let late cursor packets visually resurrect an expired peer", () => {
    const harness = createHarness();
    harness.socket.trigger("presence-update", [peer(true)]);
    harness.socket.trigger("presence-update", [peer(false)]);
    vi.advanceTimersByTime(IDLE_EXPIRE_MS);
    expect(harness.collaborators().has("peer")).toBe(true);

    harness.socket.trigger("cursor-move", {
      presenceId: "peer",
      pointer: { x: 90, y: 60, tool: "pointer" },
      username: "Peer",
      color: "#123456",
    });
    harness.runFrame(50);
    expect(harness.collaborators().has("peer")).toBe(true);
    expect(harness.collaborators().get("peer")?.username).toBe("");
    expect(harness.collaborators().get("peer")?.pointer).toBeUndefined();
    harness.binding.dispose();
  });
});

describe("remote cursor interpolation", () => {
  it("interpolates back-to-back samples even before the first frame renders", () => {
    const harness = createHarness();
    harness.socket.trigger("presence-update", [peer(true)]);
    harness.socket.trigger("cursor-move", {
      presenceId: "peer",
      pointer: { x: 0, y: 0, tool: "pointer" },
      username: "Peer",
      color: "#123456",
    });
    harness.socket.trigger("cursor-move", {
      presenceId: "peer",
      pointer: { x: 80, y: 40, tool: "pointer" },
      username: "Peer",
      color: "#123456",
    });

    harness.runFrame(40);
    expect(harness.collaborators().get("peer")?.pointer.x).toBe(40);
    harness.binding.dispose();
  });

  it("renders between consecutive samples before reaching the new target", () => {
    const harness = createHarness();
    harness.socket.trigger("presence-update", [peer(true)]);
    harness.socket.trigger("cursor-move", {
      presenceId: "peer",
      pointer: { x: 0, y: 0, tool: "pointer" },
      username: "Peer",
      color: "#123456",
    });
    harness.runFrame(0);

    harness.socket.trigger("cursor-move", {
      presenceId: "peer",
      pointer: { x: 80, y: 40, tool: "pointer" },
      username: "Peer",
      color: "#123456",
    });
    harness.runFrame(40);

    const midpoint = harness.collaborators().get("peer")?.pointer;
    expect(midpoint.x).toBeGreaterThan(0);
    expect(midpoint.x).toBeLessThan(80);
    expect(midpoint.y).toBeGreaterThan(0);
    expect(midpoint.y).toBeLessThan(40);

    harness.runFrame(80);
    expect(harness.collaborators().get("peer")?.pointer).toEqual({
      x: 80,
      y: 40,
      tool: "pointer",
    });
    harness.binding.dispose();
  });
});
