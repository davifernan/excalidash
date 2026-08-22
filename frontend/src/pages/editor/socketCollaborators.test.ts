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

describe("socket collaborators", () => {
  it("does not require selections in presence and removes the collaborator through cleanup", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    let collaborators = new Map<string, any>();
    const api = {
      getAppState: () => ({ collaborators }),
      updateScene: vi.fn((scene: any) => {
        collaborators = scene.collaborators;
      }),
    };
    const binding = bindSocketCollaborators({
      socket: socket as any,
      api,
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
    expect(collaborators.get("peer")?.selectedElementIds).toEqual({});

    socket.trigger("presence-update", []);
    expect(collaborators.has("peer")).toBe(false);
    binding.dispose();
  });

  it("keeps an inactive connected peer in Excalidraw so follow mode is not cancelled", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    let collaborators = new Map<string, any>();
    const api = {
      getAppState: () => ({ collaborators }),
      updateScene: vi.fn((scene: any) => {
        collaborators = scene.collaborators;
      }),
    };
    bindSocketCollaborators({
      socket: socket as any,
      api,
      onPeersChange: vi.fn(),
    });

    socket.trigger("presence-update", [
      {
        presenceId: "follow-target",
        name: "Target",
        color: "#123456",
        isActive: true,
      },
    ]);
    expect(collaborators.has("follow-target")).toBe(true);

    socket.trigger("presence-update", [
      {
        presenceId: "follow-target",
        name: "Target",
        color: "#123456",
        isActive: false,
      },
    ]);

    // Excalidraw clears appState.userToFollow when its target disappears from
    // this map. A blurred tab is still connected and must therefore stay in
    // the map; an empty presence update remains the real-departure signal.
    expect(collaborators.has("follow-target")).toBe(true);
  });

  it("preserves the large-selection status when presence refreshes the collaborator name", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = new FakeSocket();
    let collaborators = new Map<string, any>([
      [
        "peer",
        {
          username: "Peer · large selection",
          selectionAllSelected: true,
          selectedElementIds: {},
        },
      ],
    ]);
    const api = {
      getAppState: () => ({ collaborators }),
      updateScene: vi.fn((scene: any) => {
        collaborators = scene.collaborators;
      }),
    };
    bindSocketCollaborators({ socket: socket as any, api, onPeersChange: vi.fn() });

    socket.trigger("presence-update", [
      {
        presenceId: "peer",
        name: "Peer",
        color: "#123456",
        isActive: true,
      },
    ]);

    expect(collaborators.get("peer")?.username).toBe("Peer · large selection");
  });
});
