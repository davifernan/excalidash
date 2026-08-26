import { describe, expect, it, vi } from "vitest";

import {
  applyPatch,
  createCollaborationCapability,
  readCollaborator,
  readFollowIntent,
} from "./collaboration";
import type { CollaboratorPatch, ElementId, SocketId } from "./types";

const id = (value: string) => value as SocketId;

describe("merging a collaborator patch", () => {
  it("keeps fields this contract never names", () => {
    const existing = {
      id: "s1",
      username: "Ada",
      color: { background: "#f00", stroke: "#f00" },
      button: "down",
      isCurrentUser: false,
    };
    const merged = applyPatch(existing, { socketId: id("s1"), selectedIds: ["e1" as ElementId] });
    expect(merged.color).toEqual({ background: "#f00", stroke: "#f00" });
    expect(merged.button).toBe("down");
    expect(merged.isCurrentUser).toBe(false);
    expect(merged.username).toBe("Ada");
  });

  it("writes only what the patch mentions", () => {
    const merged = applyPatch({ id: "s1", username: "Ada" }, { socketId: id("s1") });
    expect(merged.username).toBe("Ada");
  });

  it("turns a selection list into the shape the editor keeps", () => {
    const merged = applyPatch(undefined, {
      socketId: id("s1"),
      selectedIds: ["a", "b"] as ElementId[],
    });
    expect(merged.selectedElementIds).toEqual({ a: true, b: true });
  });

  it("removes the large-selection marker rather than writing false", () => {
    const withMarker = applyPatch(undefined, {
      socketId: id("s1"),
      selectionAllSelected: true,
    });
    expect(withMarker.selectionAllSelected).toBe(true);
    const cleared = applyPatch(withMarker, {
      socketId: id("s1"),
      selectionAllSelected: false,
    });
    expect("selectionAllSelected" in cleared).toBe(false);
  });

  it("lets two independent writers share one collaborator", () => {
    // Presence sets the name and colour; remote selection sets the selection.
    // Neither may erase the other.
    const afterPresence = applyPatch({ color: { background: "#0f0" } }, {
      socketId: id("s1"),
      name: "Grace",
    } satisfies CollaboratorPatch);
    const afterSelection = applyPatch(afterPresence, {
      socketId: id("s1"),
      selectedIds: ["e9" as ElementId],
    });
    expect(afterSelection.username).toBe("Grace");
    expect(afterSelection.color).toEqual({ background: "#0f0" });
    expect(afterSelection.selectedElementIds).toEqual({ e9: true });
  });
});

describe("reading a collaborator", () => {
  it("projects the fields the contract names", () => {
    const info = readCollaborator("s1", {
      username: "Ada",
      pointer: { x: 1, y: 2 },
      selectedElementIds: { e1: true },
      selectionAllSelected: true,
      color: { background: "#f00" },
    });
    expect(info).toEqual({
      socketId: "s1",
      name: "Ada",
      avatarUrl: null,
      pointer: { x: 1, y: 2 },
      selectedIds: ["e1"],
      selectionAllSelected: true,
      // Named by the contract since the presence path needed to set them; a
      // projection that drops them is how socketCollaborators stayed on the
      // raw handle.
      color: "#f00",
      pointerButton: null,
      isSelf: false,
    });
  });

  it("reports no pointer rather than a half one", () => {
    expect(readCollaborator("s1", { pointer: { x: 1 } }).pointer).toBeNull();
  });
});

describe("reading a follow intent", () => {
  it("takes the target and the action", () => {
    expect(readFollowIntent({ userToFollow: { socketId: "s2" }, action: "FOLLOW" })).toEqual({
      targetSocketId: "s2",
      action: "FOLLOW",
    });
  });

  it("reports no target when following stops, rather than dropping the event", () => {
    expect(readFollowIntent({ userToFollow: null, action: "UNFOLLOW" })).toEqual({
      targetSocketId: null,
      action: "UNFOLLOW",
    });
  });
});

describe("the collaboration capability", () => {
  const makeApi = (collaborators: unknown = new Map()) => ({
    getAppState: () => ({ collaborators }),
    updateScene: vi.fn(),
  });

  it("accepts the map shape the editor keeps", () => {
    const api = makeApi(new Map([["s1", { username: "Ada" }]]));
    const result = createCollaborationCapability(() => api).readCollaborators();
    expect(result.ok && result.value.map((c) => c.name)).toEqual(["Ada"]);
  });

  it("accepts the entry-array shape too", () => {
    const api = makeApi([["s1", { username: "Ada" }]]);
    const result = createCollaborationCapability(() => api).readCollaborators();
    expect(result.ok && result.value.map((c) => c.socketId)).toEqual(["s1"]);
  });

  it("writes followedBy as a Set, because an array renders nothing and says nothing", () => {
    const api = makeApi();
    createCollaborationCapability(() => api).setFollowedBy([id("s1"), id("s2")]);
    const written = api.updateScene.mock.calls[0][0] as {
      appState: { followedBy: unknown };
    };
    expect(written.appState.followedBy).toBeInstanceOf(Set);
    expect([...(written.appState.followedBy as Set<string>)]).toEqual(["s1", "s2"]);
  });

  it("preserves the collaborator name in Excalidraw's native follow badge", () => {
    const api = makeApi(new Map([["s1", { username: "Ada" }]]));
    createCollaborationCapability(() => api).follow(id("s1"));
    expect(api.updateScene).toHaveBeenCalledWith({
      appState: { userToFollow: { socketId: "s1", username: "Ada" } },
    });
  });

  it("does not write at all for an empty patch list", () => {
    const api = makeApi();
    createCollaborationCapability(() => api).patchCollaborators([]);
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("composes two patches in the same tick instead of letting the second win", () => {
    // updateScene goes through setState on React 18, so the editor's map is
    // still the old one when the second call reads it. Presence sets a name,
    // remote selection sets a selection; neither may erase the other.
    const api = makeApi(new Map());
    const capability = createCollaborationCapability(() => api);

    capability.patchCollaborators([{ socketId: id("s1"), name: "Grace" }]);
    capability.patchCollaborators([{ socketId: id("s1"), selectedIds: ["e9" as ElementId] }]);

    const written = api.updateScene.mock.calls[1][0] as {
      collaborators: Map<string, Record<string, unknown>>;
    };
    const entry = written.collaborators.get("s1")!;
    expect(entry.username).toBe("Grace");
    expect(entry.selectedElementIds).toEqual({ e9: true });
  });

  it("reads the pending collaborator state until the editor applies it", () => {
    const stored = new Map([
      ["s1", { username: "Grace · large selection", selectionAllSelected: true }],
    ]);
    const api = makeApi(stored);
    const capability = createCollaborationCapability(() => api);

    capability.patchCollaborators([
      {
        socketId: id("s1"),
        name: "Grace",
        selectedIds: [],
        selectionAllSelected: false,
      },
    ]);

    const read = capability.readCollaborators();
    expect(read.ok && read.value[0]).toMatchObject({
      name: "Grace",
      selectedIds: [],
      selectionAllSelected: false,
    });
  });

  it("goes back to the editor's map once the write has landed", () => {
    const api = makeApi(new Map());
    const capability = createCollaborationCapability(() => api);
    capability.patchCollaborators([{ socketId: id("s1"), name: "Grace" }]);

    // The editor now reports a map of its own; it is the truth again.
    const settled = makeApi(new Map([["s2", { username: "Ada" }]]));
    const after = createCollaborationCapability(() => settled);
    const read = after.readCollaborators();
    expect(read.ok && read.value.map((c) => c.socketId)).toEqual(["s2"]);
  });

  it("reports not-ready without an editor rather than throwing", () => {
    const result = createCollaborationCapability(() => null).readCollaborators();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not-ready");
  });
});

describe("two patches in the same tick, with somebody already in the room", () => {
  /**
   * The case the old `live.size === 0` switch could not see.
   *
   * An empty room was the only situation in which it read `pending`; with one
   * collaborator already there -- the normal case -- the second patch of a tick
   * threw the pending map away, read the stale one and erased the first patch.
   */
  it("does not let the second patch erase the first", () => {
    let stored: unknown = new Map([["existing", { id: "existing", username: "Ada" }]]);
    const api = {
      getAppState: () => ({ collaborators: stored }),
      // Deliberately NOT synchronous about it: updateScene goes through setState,
      // so the read straight afterwards still sees the old map. Storing it only
      // on the next call is what makes this test the real situation.
      updateScene: (scene: any) => {
        pendingWrite = scene.collaborators;
      },
    };
    let pendingWrite: unknown = null;
    const collaboration = createCollaborationCapability(() => api as never);

    collaboration.patchCollaborators([{ socketId: "peer" as never, color: "#f00" }]);
    collaboration.patchCollaborators([{ socketId: "peer" as never, name: "Grace" }]);

    // The editor finally applies the last write it was handed.
    stored = pendingWrite;
    const read = collaboration.readCollaborators();
    expect(read.ok).toBe(true);
    const peer = read.ok ? read.value.find((c) => c.socketId === ("peer" as never)) : null;
    expect(peer?.color).toBe("#f00");
    expect(peer?.name).toBe("Grace");
  });
});
