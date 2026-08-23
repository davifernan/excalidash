import { afterEach, describe, expect, it, vi } from "vitest";
import { bindRemoteSelection, REMOTE_SELECTION_LIMITS } from "./remoteSelection";

class FakeSocket {
  private handlers = new Map<string, (payload: any) => void>();
  emit = vi.fn();

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
  vi.useRealTimers();
});

describe("remote selection binding", () => {
  it("batches a selection snapshot into one collaborator patch", () => {
    const socket = new FakeSocket();
    const collaboration = {
      readCollaborators: vi.fn(() => ({ ok: true, value: [] })),
      patchCollaborators: vi.fn(() => ({ ok: true, value: undefined })),
    };
    bindRemoteSelection({
      socket: socket as any,
      drawingId: "drawing-1",
      collaboration: collaboration as any,
      onCapabilityFailure: vi.fn(),
    });

    socket.trigger("selection-snapshot", {
      drawingId: "drawing-1",
      selections: [
        { presenceId: "peer-1", selectedElementIds: ["a"] },
        { presenceId: "peer-2", selectedElementIds: ["b"] },
      ],
    });

    expect(collaboration.patchCollaborators).toHaveBeenCalledOnce();
    expect(collaboration.patchCollaborators).toHaveBeenCalledWith([
      {
        socketId: "peer-1",
        name: "Participant",
        selectedIds: ["a"],
        selectionAllSelected: false,
      },
      {
        socketId: "peer-2",
        name: "Participant",
        selectedIds: ["b"],
        selectionAllSelected: false,
      },
    ]);
  });

  it("merges selected ids into the existing collaborator", () => {
    const socket = new FakeSocket();
    const collaboration = {
      readCollaborators: vi.fn(() => ({
        ok: true,
        value: [
          {
            socketId: "peer",
            name: "Nilo",
            avatarUrl: null,
            pointer: null,
            selectedIds: [],
            selectionAllSelected: false,
          },
        ],
      })),
      patchCollaborators: vi.fn(() => ({ ok: true, value: undefined })),
    };
    bindRemoteSelection({
      socket: socket as any,
      drawingId: "drawing-1",
      collaboration: collaboration as any,
      onCapabilityFailure: vi.fn(),
    });

    socket.trigger("selection-update", {
      drawingId: "drawing-1",
      presenceId: "peer",
      selectedElementIds: ["a", "b"],
    });

    expect(collaboration.patchCollaborators).toHaveBeenCalledWith([
      {
        socketId: "peer",
        name: "Nilo",
        selectedIds: ["a", "b"],
        selectionAllSelected: false,
      },
    ]);
  });

  it("applies a private join snapshot in wire order", () => {
    const socket = new FakeSocket();
    let collaborators: any[] = [];
    const collaboration = {
      readCollaborators: vi.fn(() => ({ ok: true, value: collaborators })),
      patchCollaborators: vi.fn((patches: any[]) => {
        for (const patch of patches) {
          const previous = collaborators.find((entry) => entry.socketId === patch.socketId);
          collaborators = [
            ...collaborators.filter((entry) => entry.socketId !== patch.socketId),
            {
              socketId: patch.socketId,
              name: patch.name ?? previous?.name ?? null,
              avatarUrl: previous?.avatarUrl ?? null,
              pointer: previous?.pointer ?? null,
              selectedIds: patch.selectedIds ?? previous?.selectedIds ?? [],
              selectionAllSelected:
                patch.selectionAllSelected ?? previous?.selectionAllSelected ?? false,
            },
          ];
        }
        return { ok: true, value: undefined };
      }),
    };
    bindRemoteSelection({
      socket: socket as any,
      drawingId: "drawing-1",
      collaboration: collaboration as any,
      onCapabilityFailure: vi.fn(),
    });

    socket.trigger("selection-snapshot", {
      drawingId: "drawing-1",
      selections: [{ presenceId: "peer", selectedElementIds: ["before"] }],
    });
    socket.trigger("selection-update", {
      drawingId: "drawing-1",
      presenceId: "peer",
      selectedElementIds: ["after"],
    });

    expect(collaborators.find((entry) => entry.socketId === "peer")?.selectedIds).toEqual([
      "after",
    ]);
  });

  it("renders an all-selected marker as a large-selection status without guessed ids", () => {
    const socket = new FakeSocket();
    const collaboration = {
      readCollaborators: vi.fn(() => ({
        ok: true,
        value: [
          {
            socketId: "peer",
            name: "Nilo",
            avatarUrl: null,
            pointer: null,
            selectedIds: ["stale"],
            selectionAllSelected: false,
          },
        ],
      })),
      patchCollaborators: vi.fn(() => ({ ok: true, value: undefined })),
    };
    bindRemoteSelection({
      socket: socket as any,
      drawingId: "drawing-1",
      collaboration: collaboration as any,
      onCapabilityFailure: vi.fn(),
    });

    socket.trigger("selection-update", {
      drawingId: "drawing-1",
      presenceId: "peer",
      allSelected: true,
    });

    expect(collaboration.patchCollaborators).toHaveBeenCalledWith([
      {
        socketId: "peer",
        name: "Nilo · large selection",
        selectedIds: [],
        selectionAllSelected: true,
      },
    ]);
  });

  it("sends a leading update and the final throttled selection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const socket = new FakeSocket();
    const binding = bindRemoteSelection({
      socket: socket as any,
      drawingId: "drawing-1",
      collaboration: {} as any,
      onCapabilityFailure: vi.fn(),
    });

    binding.publish(["first"]);
    vi.setSystemTime(1_010);
    binding.publish(["second"]);
    binding.publish(["final"]);
    expect(socket.emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(40);
    expect(socket.emit).toHaveBeenLastCalledWith("selection-update", {
      drawingId: "drawing-1",
      selectedElementIds: ["final"],
    });
  });

  it("budgets outgoing selections by encoded bytes instead of id count or character length", () => {
    const socket = new FakeSocket();
    const binding = bindRemoteSelection({
      socket: socket as any,
      drawingId: "drawing-1",
      collaboration: {} as any,
      onCapabilityFailure: vi.fn(),
      throttleMs: 0,
    });
    const longId = "x".repeat(300);
    const selectedElementIds = [
      ...Array.from({ length: 300 }, (_, index) => [`id-${index}`, true] as const),
      [longId, true] as const,
    ].map(([id]) => id);

    binding.publish(selectedElementIds);

    expect(socket.emit.mock.calls[0][1].selectedElementIds).toHaveLength(301);
    expect(socket.emit.mock.calls[0][1].selectedElementIds).toContain(longId);
    expect(
      new TextEncoder().encode(JSON.stringify(socket.emit.mock.calls[0][1])).byteLength,
    ).toBeLessThanOrEqual(REMOTE_SELECTION_LIMITS.payloadBytes);

    const oversizedSelection = Array.from({ length: 30_000 }, (_, index) => `element-${index}`);
    binding.publish(oversizedSelection);
    expect(socket.emit).toHaveBeenLastCalledWith("selection-update", {
      drawingId: "drawing-1",
      allSelected: true,
    });
  });

  it("reports a collaborator write failure through the caller's user channel", () => {
    const socket = new FakeSocket();
    const failure = {
      ok: false as const,
      code: "editor-changed" as const,
      seam: "collaboration.patchCollaborators",
    };
    const onCapabilityFailure = vi.fn();
    bindRemoteSelection({
      socket: socket as any,
      drawingId: "drawing-1",
      collaboration: {
        readCollaborators: () => ({ ok: true, value: [] }),
        patchCollaborators: () => failure,
      } as any,
      onCapabilityFailure,
    });

    socket.trigger("selection-update", {
      drawingId: "drawing-1",
      presenceId: "peer",
      selectedElementIds: ["a"],
    });

    expect(onCapabilityFailure).toHaveBeenCalledWith(failure);
  });
});
