import { afterEach, describe, expect, it, vi } from "vitest";
import { bindSocketCollaborators } from "./socketCollaborators";

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
      readFollowState: () => ({ ok: true as const, value: { followingSocketId: null, followedBySocketIds: [] } }),
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
    bindSocketCollaborators({ socket: socket as any, collaboration: capability, onPeersChange: vi.fn() });

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
});
