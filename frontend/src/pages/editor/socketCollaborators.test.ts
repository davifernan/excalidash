import { afterEach, describe, expect, it, vi } from "vitest";
import { bindSocketCollaborators, withAwayStatus } from "./socketCollaborators";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A collaboration capability backed by a plain map.
 *
 * The old fixture faked the raw editor handle -- `getAppState` and
 * `updateScene`. Faking the capability instead is the point of the migration:
 * the test now asserts what this file asks the boundary for, not how the editor
 * happens to store it.
 */
const fakeCollaboration = (initial: Record<string, any> = {}) => {
  const peers = new Map<string, any>(Object.entries(initial));
  return {
    peers,
    capability: {
      readCollaborators: () => ({
        ok: true as const,
        value: [...peers.entries()].map(([socketId, peer]) => ({
          socketId,
          name: peer.name ?? null,
          avatarUrl: null,
          pointer: peer.pointer ?? null,
          selectedIds: peer.selectedIds ?? [],
          selectionAllSelected: peer.selectionAllSelected === true,
          color: peer.color ?? null,
          pointerButton: peer.pointerButton ?? null,
          isSelf: peer.isSelf === true,
        })),
      }),
      patchCollaborators: vi.fn((patches: readonly any[]) => {
        for (const patch of patches) {
          const id = String(patch.socketId);
          const { socketId: _drop, ...rest } = patch;
          peers.set(id, {
            ...(peers.get(id) ?? {}),
            ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          });
        }
        return { ok: true as const, value: undefined };
      }),
      removeCollaborators: vi.fn((ids: readonly string[]) => {
        for (const id of ids) peers.delete(String(id));
        return { ok: true as const, value: undefined };
      }),
      readFollowState: () => ({
        ok: true as const,
        value: { followingSocketId: null, followedBySocketIds: [] },
      }),
      follow: () => ({ ok: true as const, value: undefined }),
      setFollowedBy: () => ({ ok: true as const, value: undefined }),
      onFollowIntent: () => () => {},
      onPointerUpdate: () => () => {},
    } as any,
  };
};

describe("socket collaborators", () => {
  it("does not require selections in presence and removes the collaborator through cleanup", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    const { peers, capability } = fakeCollaboration();
    const binding = bindSocketCollaborators({
      socket: socket as any,
      collaboration: capability,
      onPeersChange: vi.fn(),
    });

    socket.trigger("presence-update", [
      {
        presenceId: "peer",
        name: "Peer",
        color: "#123456",
        isActive: true,
      },
    ]);
    expect(peers.get("peer")?.selectedIds).toEqual([]);

    socket.trigger("presence-update", []);
    expect(peers.has("peer")).toBe(false);
    binding.dispose();
  });

  it("preserves the large-selection status when presence refreshes the collaborator name", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    const { peers, capability } = fakeCollaboration({
      peer: { name: "Peer · large selection", selectionAllSelected: true, selectedIds: [] },
    });
    bindSocketCollaborators({
      socket: socket as any,
      collaboration: capability,
      onPeersChange: vi.fn(),
    });

    socket.trigger("presence-update", [
      {
        presenceId: "peer",
        name: "Peer",
        color: "#123456",
        isActive: true,
      },
    ]);

    expect(peers.get("peer")?.name).toBe("Peer · large selection");
  });

  it("withAwayStatus appends or strips exactly one suffix, idempotently", () => {
    expect(withAwayStatus("Peer", true)).toBe("Peer · away");
    expect(withAwayStatus("Peer · away", true)).toBe("Peer · away");
    expect(withAwayStatus("Peer · away", false)).toBe("Peer");
    expect(withAwayStatus("Peer", false)).toBe("Peer");
  });

  it("NIL-372: does not delete a collaborator merely because a tab lost focus", () => {
    // This is the root-cause regression test: before the fix, `isActive: false`
    // went straight into the `gone` list and `collaboration.removeCollaborators`
    // ran, which is exactly what made following someone end the moment their
    // browser tab lost focus -- the only way to drive two browsers on one
    // screen. Run against the unpatched file (git stash the production change)
    // and this fails with `peers.has("peer")` false; that failure, with the
    // stashed diff restored afterwards, is this test's red probe.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    const { peers, capability } = fakeCollaboration();
    bindSocketCollaborators({
      socket: socket as any,
      collaboration: capability,
      onPeersChange: vi.fn(),
    });

    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: true },
    ]);
    expect(peers.has("peer")).toBe(true);

    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: false },
    ]);
    expect(peers.has("peer")).toBe(true);
    expect(capability.removeCollaborators).not.toHaveBeenCalled();
    // Frozen, not moved: no patch at all was written for the now-inactive
    // peer, so whatever pointer/name they had while active simply stands.
    expect(peers.get("peer")?.name).toBe("Peer");
  });

  it("marks a peer away only after the grace window, and never if they return sooner", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    const { peers, capability } = fakeCollaboration();
    bindSocketCollaborators({
      socket: socket as any,
      collaboration: capability,
      onPeersChange: vi.fn(),
    });

    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: true },
    ]);
    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: false },
    ]);
    expect(peers.get("peer")?.name).toBe("Peer");

    // An ordinary alt-tab, well inside the grace window: no visible change.
    vi.advanceTimersByTime(1_000);
    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: true },
    ]);
    expect(peers.get("peer")?.name).toBe("Peer");
    vi.advanceTimersByTime(10_000);
    expect(peers.get("peer")?.name).toBe("Peer");

    // Genuinely away past the grace window: now it shows.
    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: false },
    ]);
    vi.advanceTimersByTime(4_000);
    expect(peers.get("peer")?.name).toBe("Peer · away");

    // Returning clears it immediately, without a second grace window.
    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: true },
    ]);
    expect(peers.get("peer")?.name).toBe("Peer");

    vi.useRealTimers();
  });

  it("gives a peer who has never been seen active a name immediately, already marked away", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    const { peers, capability } = fakeCollaboration();
    bindSocketCollaborators({
      socket: socket as any,
      collaboration: capability,
      onPeersChange: vi.fn(),
    });

    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: false },
    ]);
    expect(peers.get("peer")?.name).toBe("Peer · away");
    expect(capability.removeCollaborators).not.toHaveBeenCalled();
  });

  it("a real departure still removes the collaborator even while marked away", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    const { peers, capability } = fakeCollaboration();
    bindSocketCollaborators({
      socket: socket as any,
      collaboration: capability,
      onPeersChange: vi.fn(),
    });

    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: true },
    ]);
    socket.trigger("presence-update", [
      { presenceId: "peer", name: "Peer", color: "#123456", isActive: false },
    ]);
    vi.advanceTimersByTime(4_000);
    expect(peers.get("peer")?.name).toBe("Peer · away");

    socket.trigger("presence-update", []);
    expect(peers.has("peer")).toBe(false);

    vi.useRealTimers();
  });

  describe("cursor smoothing (NIL-373)", () => {
    const withControllableFrames = () => {
      let pending: (() => void) | null = null;
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((cb: () => void) => {
          pending = cb;
          return 1;
        }),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      return {
        // Advances the fake clock, then runs whichever frame is pending --
        // the same order a real browser observes (time passes, then paints).
        advanceFrame: (ms: number) => {
          vi.advanceTimersByTime(ms);
          const cb = pending;
          pending = null;
          cb?.();
        },
        framePending: () => pending !== null,
      };
    };

    it("interpolates a second cursor position across frames instead of snapping to it", () => {
      vi.useFakeTimers();
      const { advanceFrame } = withControllableFrames();
      const socket = new FakeSocket();
      const { peers, capability } = fakeCollaboration();
      bindSocketCollaborators({
        socket: socket as any,
        collaboration: capability,
        onPeersChange: vi.fn(),
      });

      // A first-ever sighting of this cursor has nothing to glide from --
      // it lands immediately, the same as before this change.
      socket.trigger("cursor-move", {
        presenceId: "peer",
        pointer: { x: 0, y: 0 },
        button: "up",
        username: "Peer",
        color: "#123456",
      });
      advanceFrame(0);
      expect(peers.get("peer")?.pointer).toEqual({ x: 0, y: 0 });

      // A second position, some time later, is where the smoothing this
      // ticket asks for actually shows up.
      socket.trigger("cursor-move", {
        presenceId: "peer",
        pointer: { x: 100, y: 0 },
        button: "up",
        username: "Peer",
        color: "#123456",
      });
      advanceFrame(25); // halfway through the 50ms glide
      const mid = peers.get("peer")?.pointer;
      expect(mid).toBeTruthy();
      expect(mid.x).toBeGreaterThan(0);
      expect(mid.x).toBeLessThan(100);

      advanceFrame(25); // the glide completes
      expect(peers.get("peer")?.pointer).toEqual({ x: 100, y: 0 });

      vi.useRealTimers();
    });

    it("takes several distinct frames to arrive, then stops scheduling more", () => {
      // Distinguishes real interpolation from a stale-but-passing sequence:
      // the pre-smoothing code also happened to reschedule exactly once more
      // after any cursor-move ("in case cursors arrived while this one was
      // drawing"), so a single before/after framePending() check would have
      // stayed green against the unpatched file. Three or more genuinely
      // distinct, strictly increasing samples cannot come from a single
      // snap-then-one-extra-frame implementation.
      vi.useFakeTimers();
      const { advanceFrame, framePending } = withControllableFrames();
      const socket = new FakeSocket();
      const { peers, capability } = fakeCollaboration();
      bindSocketCollaborators({
        socket: socket as any,
        collaboration: capability,
        onPeersChange: vi.fn(),
      });

      socket.trigger("cursor-move", {
        presenceId: "peer",
        pointer: { x: 0, y: 0 },
        username: "Peer",
        color: "#123456",
      });
      advanceFrame(0);
      socket.trigger("cursor-move", {
        presenceId: "peer",
        pointer: { x: 100, y: 0 },
        username: "Peer",
        color: "#123456",
      });

      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        advanceFrame(10);
        samples.push(peers.get("peer")?.pointer.x);
      }
      for (let i = 1; i < samples.length; i += 1) {
        expect(samples[i]).toBeGreaterThan(samples[i - 1]);
      }
      expect(samples[samples.length - 1]).toBe(100);
      // Arrived: nothing left to animate, nothing left scheduled.
      expect(framePending()).toBe(false);

      vi.useRealTimers();
    });

    it("glides from the cursor's current position, not the previous target, on a fast third update", () => {
      vi.useFakeTimers();
      const { advanceFrame } = withControllableFrames();
      const socket = new FakeSocket();
      const { peers, capability } = fakeCollaboration();
      bindSocketCollaborators({
        socket: socket as any,
        collaboration: capability,
        onPeersChange: vi.fn(),
      });

      socket.trigger("cursor-move", {
        presenceId: "peer",
        pointer: { x: 0, y: 0 },
        username: "Peer",
        color: "#123456",
      });
      advanceFrame(0);
      socket.trigger("cursor-move", {
        presenceId: "peer",
        pointer: { x: 100, y: 0 },
        username: "Peer",
        color: "#123456",
      });
      advanceFrame(25); // now at x=50, still gliding toward 100
      const midway = peers.get("peer")?.pointer.x;

      // A third position arrives before the second glide finished.
      socket.trigger("cursor-move", {
        presenceId: "peer",
        pointer: { x: 100, y: 40 },
        username: "Peer",
        color: "#123456",
      });
      advanceFrame(0);
      // The very next frame must start from where the cursor actually was
      // (~50), not snap back to the target it never reached (0 or 100).
      const justAfterRedirect = peers.get("peer")?.pointer;
      expect(justAfterRedirect.x).toBeCloseTo(midway, 0);
      expect(justAfterRedirect.y).toBe(0);

      advanceFrame(50);
      expect(peers.get("peer")?.pointer).toEqual({ x: 100, y: 40 });

      vi.useRealTimers();
    });
  });
});
