/**
 * Collaboration: who else is on the board, and who is following whom.
 *
 * Writes are patches, not replacements. The editor keeps fields on a
 * collaborator that this contract does not name -- colour, pointer button,
 * cursor state, whether it is the current user -- and the real consumers update
 * one of them at a time. Remote selection changes only the selection; presence
 * changes only the name and colour. A write that replaced the whole object would
 * drop whatever the other one had just set.
 */

import { reportFailure } from "./compatibility/diagnostics";
import type { CollaborationCapability } from "./capabilities";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type {
  CollaboratorInfo,
  CollaboratorPatch,
  ElementId,
  FollowIntent,
  FollowState,
  PointerUpdate,
  ScenePoint,
  SocketId,
  Unsubscribe,
} from "./types";
import { packageVersion } from "./version";

export type CollaborationApi = {
  getAppState: () => Record<string, unknown>;
  updateScene: (change: Record<string, unknown>) => void;
  onUserFollow?: (listener: (payload: unknown) => void) => Unsubscribe;
};

type RawCollaborator = Record<string, unknown>;

const asMap = (value: unknown): Map<string, RawCollaborator> => {
  if (value instanceof Map) return new Map(value as Map<string, RawCollaborator>);
  if (Array.isArray(value)) return new Map(value as [string, RawCollaborator][]);
  return new Map();
};

const idsOf = (value: unknown): readonly ElementId[] =>
  value && typeof value === "object"
    ? (Object.keys(value as Record<string, unknown>) as ElementId[])
    : [];

const point = (value: unknown): ScenePoint | null => {
  if (!value || typeof value !== "object") return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
};

export const readCollaborator = (id: string, raw: RawCollaborator): CollaboratorInfo => ({
  socketId: id as SocketId,
  name: typeof raw.username === "string" ? raw.username : null,
  avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : null,
  pointer: point(raw.pointer),
  selectedIds: idsOf(raw.selectedElementIds),
  selectionAllSelected: raw.selectionAllSelected === true,
  // The editor stores the colour as `{background, stroke}`; both halves always
  // carry the same value here, so the contract names one colour.
  color:
    raw.color && typeof raw.color === "object" && typeof (raw.color as any).background === "string"
      ? ((raw.color as any).background as string)
      : null,
  pointerButton: raw.button === "down" ? "down" : raw.button === "up" ? "up" : null,
  isSelf: raw.isCurrentUser === true,
});

/**
 * Merge a patch into the editor's own collaborator record.
 *
 * Unnamed fields survive because the record is spread first. Only what the
 * patch actually mentions is written -- `undefined` means "leave it", which is
 * what lets two independent writers share one collaborator.
 */
export const applyPatch = (
  existing: RawCollaborator | undefined,
  patch: CollaboratorPatch,
): RawCollaborator => {
  const next: RawCollaborator = { ...(existing ?? {}), id: patch.socketId };
  if (patch.name !== undefined) next.username = patch.name;
  if (patch.avatarUrl !== undefined) next.avatarUrl = patch.avatarUrl;
  if (patch.pointer !== undefined) next.pointer = patch.pointer;
  if (patch.selectedIds !== undefined) {
    next.selectedElementIds = Object.fromEntries(
      patch.selectedIds.map((id) => [String(id), true] as const),
    );
  }
  if (patch.selectionAllSelected !== undefined) {
    if (patch.selectionAllSelected) next.selectionAllSelected = true;
    else delete next.selectionAllSelected;
  }
  if (patch.color !== undefined) {
    next.color = patch.color === null ? undefined : { background: patch.color, stroke: patch.color };
  }
  if (patch.pointerButton !== undefined) {
    next.button = patch.pointerButton ?? undefined;
  }
  if (patch.isSelf !== undefined) next.isCurrentUser = patch.isSelf;
  return next;
};

export const readFollowIntent = (payload: unknown): FollowIntent | null => {
  if (!payload || typeof payload !== "object") return null;
  const { userToFollow, action } = payload as {
    userToFollow?: { socketId?: unknown };
    action?: unknown;
  };
  const socketId =
    userToFollow && typeof userToFollow.socketId === "string"
      ? (userToFollow.socketId as SocketId)
      : null;
  return { targetSocketId: socketId, action: typeof action === "string" ? action : "" };
};

export const createCollaborationCapability = (
  getApi: () => CollaborationApi | null,
): CollaborationCapability => {
  const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
    if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
    return result;
  };
  const notReady = <T>(seam: string): CapabilityResult<T> =>
    report(fail("not-ready", seam, { detail: "the editor handle is not attached" }));

  /**
   * The map this capability last wrote, if the editor has not caught up yet.
   *
   * Excalidraw's updateScene goes through setState on a React 18 class
   * component, so a read straight after a write still returns the old
   * collaborators. Two patches in the same tick would therefore both start from
   * the same stale map and the second would erase the first -- presence setting
   * a name, remote selection setting a selection, one of them silently lost.
   *
   * Cleared as soon as the editor reports the map back, so this never becomes a
   * second source of truth: it only bridges the gap until the write lands.
   */
  let pending: Map<string, RawCollaborator> | null = null;

  const currentMap = (api: CollaborationApi): Map<string, RawCollaborator> => {
    const live = asMap(api.getAppState().collaborators);
    if (pending && live.size === 0) return new Map(pending);
    // The editor has the write; its map is the truth again.
    if (pending && live.size > 0) pending = null;
    return live;
  };

  const writeMap = (api: CollaborationApi, map: Map<string, RawCollaborator>) => {
    pending = new Map(map);
    api.updateScene({ collaborators: map });
  };

  return {
    readCollaborators() {
      const api = getApi();
      if (!api) return notReady("collaboration.readCollaborators");
      const map = asMap(api.getAppState().collaborators);
      return ok([...map.entries()].map(([id, raw]) => readCollaborator(id, raw)));
    },

    patchCollaborators(patches) {
      const api = getApi();
      if (!api) return notReady("collaboration.patchCollaborators");
      if (patches.length === 0) return ok(undefined);
      const map = currentMap(api);
      for (const patch of patches) {
        map.set(String(patch.socketId), applyPatch(map.get(String(patch.socketId)), patch));
      }
      writeMap(api, map);
      return ok(undefined);
    },

    removeCollaborators(socketIds) {
      const api = getApi();
      if (!api) return notReady("collaboration.removeCollaborators");
      if (socketIds.length === 0) return ok(undefined);
      const map = currentMap(api);
      for (const id of socketIds) map.delete(String(id));
      writeMap(api, map);
      return ok(undefined);
    },

    readFollowState() {
      const api = getApi();
      if (!api) return notReady("collaboration.readFollowState");
      const appState = api.getAppState();
      const following = appState.userToFollow as { socketId?: unknown } | null | undefined;
      const followedBy = appState.followedBy;
      return ok({
        followingSocketId:
          following && typeof following.socketId === "string"
            ? (following.socketId as SocketId)
            : null,
        followedBySocketIds:
          followedBy instanceof Set
            ? ([...followedBy] as SocketId[])
            : Array.isArray(followedBy)
              ? (followedBy as SocketId[])
              : [],
      } satisfies FollowState);
    },

    follow(socketId) {
      const api = getApi();
      if (!api) return notReady("collaboration.follow");
      api.updateScene({
        appState: { userToFollow: socketId ? { socketId } : null },
      });
      return ok(undefined);
    },

    setFollowedBy(socketIds) {
      const api = getApi();
      if (!api) return notReady("collaboration.setFollowedBy");
      // A Set, because that is what the editor keeps here; handing it an array
      // leaves the avatar list rendering nothing and reporting no error.
      api.updateScene({ appState: { followedBy: new Set(socketIds.map(String)) } });
      return ok(undefined);
    },

    onFollowIntent(listener) {
      const api = getApi();
      if (!api?.onUserFollow) return () => {};
      return api.onUserFollow((payload) => {
        const intent = readFollowIntent(payload);
        if (intent) listener(intent);
      });
    },

    onPointerUpdate() {
      // The local pointer stream is a prop on the host, not a method on the
      // handle. It is wired when EditorView migrates; subscribing here before
      // then would report an event that never arrives.
      reportFailure(
        fail("unsupported", "collaboration.onPointerUpdate", {
          detail: "arrives with the host prop migration",
        }),
        packageVersion(),
      );
      return () => {};
    },
  };
};

export type { PointerUpdate };
