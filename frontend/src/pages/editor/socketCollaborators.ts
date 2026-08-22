import type { Socket } from "socket.io-client";
import { buildRemoteSceneUpdate } from "./shared";
import { withLargeSelectionStatus } from "./remoteSelection";

export interface Peer {
  presenceId: string;
  // No account id: the server keeps that to itself, because a share link puts
  // anonymous visitors in the same room as everyone else.
  name: string;
  initials: string;
  color: string;
  isActive: boolean;
}

type ExcalidrawApi = {
  getAppState: () => any;
  updateScene: (scene: any) => void;
};

type CursorPointer = {
  x: number;
  y: number;
  tool: unknown;
};

type CursorTrack = {
  data: any;
  from: CursorPointer;
  target: CursorPointer;
  receivedAt: number;
  durationMs: number;
};

// A blur is usually a momentary tab switch. Keep the person's normal visual
// identity briefly, then make absence legible without dropping follow mode.
export const COLLABORATOR_IDLE_HOLD_MS = 5_000;
export const COLLABORATOR_IDLE_EXPIRE_MS = 30_000;
export const INACTIVE_COLLABORATOR_COLOR = "#94a3b8";

// Senders publish at most every 50ms. Rendering toward each sample over a
// slightly wider window absorbs ordinary packet jitter without more traffic.
export const CURSOR_INTERPOLATION_MS = 80;

const escapeSvgText = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&apos;";
  });

const inactiveAvatarUrl = (name: string) => {
  const initial = Array.from(name.trim())[0]?.toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="${INACTIVE_COLLABORATOR_COLOR}"/><text x="16" y="21" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#334155">${escapeSvgText(initial)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const isCursorPointer = (value: unknown): value is CursorPointer => {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Record<string, unknown>;
  return (
    typeof pointer.x === "number" &&
    Number.isFinite(pointer.x) &&
    typeof pointer.y === "number" &&
    Number.isFinite(pointer.y)
  );
};

const cursorAt = (track: CursorTrack, now: number) => {
  const progress =
    track.durationMs === 0
      ? 1
      : Math.min(1, Math.max(0, (now - track.receivedAt) / track.durationMs));
  return {
    pointer: {
      ...track.target,
      x: track.from.x + (track.target.x - track.from.x) * progress,
      y: track.from.y + (track.target.y - track.from.y) * progress,
    },
    complete: progress === 1,
  };
};

export const bindSocketCollaborators = ({
  socket,
  api,
  onPeersChange,
  decorateName = (name) => name,
}: {
  socket: Socket;
  api: ExcalidrawApi;
  onPeersChange: (peers: Peer[]) => void;
  /**
   * A last say over the name Excalidraw paints beside each cursor.
   *
   * Cursor chat rides on this: Excalidraw already draws a name there and moves
   * it with the pointer, so a message appended to the name follows the cursor
   * exactly, with no renderer of ours to keep in step.
   */
  decorateName?: (name: string, presenceId: string) => string;
}) => {
  let selfPresenceId: string | null = null;
  let lastPresenceUsers: Peer[] | null = null;
  let knownPresenceIds = new Set<string>();
  const inactiveSince = new Map<string, number>();
  const cursorTracks = new Map<string, CursorTrack>();
  let animationFrameId: number | null = null;
  let inactivityTimerId: ReturnType<typeof setTimeout> | null = null;

  const updateCollaborators = (collaborators: Map<string, any>) => {
    const { sceneUpdate } = buildRemoteSceneUpdate({ collaborators });
    if (sceneUpdate) api.updateScene(sceneUpdate);
  };

  /**
   * Runs only while there is something to draw.
   *
   * It used to schedule the next frame unconditionally, so an idle editor kept
   * a sixty-times-a-second loop alive doing nothing at all. A cursor arriving
   * starts it; an empty buffer lets it stop.
   */
  const renderCursors = (now: number) => {
    animationFrameId = null;
    if (cursorTracks.size === 0) return;
    const collaborators = new Map<string, any>(api.getAppState().collaborators || []);
    let changed = false;
    cursorTracks.forEach((track, presenceId) => {
      const existing = collaborators.get(presenceId);
      if (!existing || !knownPresenceIds.has(presenceId) || inactiveSince.has(presenceId)) {
        cursorTracks.delete(presenceId);
        return;
      }
      const frame = cursorAt(track, now);
      collaborators.set(presenceId, {
        ...existing,
        ...track.data,
        pointer: frame.pointer,
        username: withLargeSelectionStatus(
          decorateName(track.data.username || existing.username || "", presenceId),
          existing.selectionAllSelected === true,
        ),
      });
      changed = true;
      if (frame.complete) cursorTracks.delete(presenceId);
    });
    if (changed) updateCollaborators(collaborators);
    if (cursorTracks.size > 0) animationFrameId = requestAnimationFrame(renderCursors);
  };

  const wake = () => {
    if (animationFrameId === null) animationFrameId = requestAnimationFrame(renderCursors);
  };

  const clearInactivityTimer = () => {
    if (inactivityTimerId !== null) clearTimeout(inactivityTimerId);
    inactivityTimerId = null;
  };

  const scheduleInactivityTransition = (users: Peer[], now: number) => {
    clearInactivityTimer();
    let nextDelay = Number.POSITIVE_INFINITY;
    users.forEach((user) => {
      if (user.isActive) return;
      const startedAt = inactiveSince.get(user.presenceId);
      if (startedAt === undefined) return;
      const age = now - startedAt;
      const delay =
        age < COLLABORATOR_IDLE_HOLD_MS
          ? COLLABORATOR_IDLE_HOLD_MS - age
          : age < COLLABORATOR_IDLE_EXPIRE_MS
            ? COLLABORATOR_IDLE_EXPIRE_MS - age
            : Number.POSITIVE_INFINITY;
      nextDelay = Math.min(nextDelay, delay);
    });
    if (!Number.isFinite(nextDelay)) return;
    inactivityTimerId = setTimeout(
      () => {
        inactivityTimerId = null;
        if (lastPresenceUsers) applyPresence(lastPresenceUsers, Date.now());
      },
      Math.max(0, Math.ceil(nextDelay)),
    );
  };

  const finishCursorTrack = (collaborators: Map<string, any>, presenceId: string) => {
    const track = cursorTracks.get(presenceId);
    if (!track) return;
    const existing = collaborators.get(presenceId) || {};
    collaborators.set(presenceId, {
      ...existing,
      ...track.data,
      pointer: track.target,
    });
    cursorTracks.delete(presenceId);
  };

  const applyPresence = (users: Peer[], now: number) => {
    const selfId = selfPresenceId || socket.id;
    const collaborators = new Map<string, any>(api.getAppState().collaborators || []);
    const nextPresenceIds = new Set(
      users.filter((user) => user.presenceId !== selfId).map((user) => user.presenceId),
    );
    knownPresenceIds.forEach((presenceId) => {
      if (nextPresenceIds.has(presenceId)) return;
      collaborators.delete(presenceId);
      cursorTracks.delete(presenceId);
      inactiveSince.delete(presenceId);
    });

    users.forEach((user) => {
      if (user.presenceId === selfId) return;
      const existing = collaborators.get(user.presenceId) || {};
      if (user.isActive) {
        inactiveSince.delete(user.presenceId);
      } else {
        if (!inactiveSince.has(user.presenceId)) inactiveSince.set(user.presenceId, now);
        finishCursorTrack(collaborators, user.presenceId);
      }
      const inactiveAge = now - (inactiveSince.get(user.presenceId) ?? now);
      if (!user.isActive && inactiveAge >= COLLABORATOR_IDLE_EXPIRE_MS) {
        const latest = collaborators.get(user.presenceId) || existing;
        collaborators.set(user.presenceId, {
          ...latest,
          // Excalidraw filters blank names from its avatar list and respects
          // renderCursor=false on the canvas. The map entry deliberately stays:
          // follow mode uses membership as the connection-lifetime signal.
          username: "",
          avatarUrl: undefined,
          userState: "away",
          isActive: false,
          pointer: latest.pointer ? { ...latest.pointer, renderCursor: false } : undefined,
        });
        return;
      }
      const color =
        !user.isActive && inactiveAge >= COLLABORATOR_IDLE_HOLD_MS
          ? INACTIVE_COLLABORATOR_COLOR
          : user.color;
      const isDimmed = !user.isActive && inactiveAge >= COLLABORATOR_IDLE_HOLD_MS;
      const latest = collaborators.get(user.presenceId) || existing;
      const pointer =
        user.isActive && latest.pointer?.renderCursor === false
          ? { ...latest.pointer, renderCursor: undefined }
          : latest.pointer;
      collaborators.set(user.presenceId, {
        ...latest,
        id: user.presenceId,
        username: withLargeSelectionStatus(
          decorateName(user.name, user.presenceId),
          latest.selectionAllSelected === true,
        ),
        color: { background: color, stroke: color },
        // Excalidraw dims cursors with this public collaborator state, but its
        // avatar colors are derived from ids. A tiny local SVG gives the same
        // inactive treatment to the avatar without DOM patching.
        userState: isDimmed ? "away" : undefined,
        avatarUrl: isDimmed ? inactiveAvatarUrl(user.name) : undefined,
        isActive: user.isActive,
        pointer,
        isCurrentUser: false,
        selectedElementIds: latest.selectedElementIds || {},
      });
    });

    knownPresenceIds = nextPresenceIds;
    onPeersChange(
      users.filter((user) => {
        if (user.presenceId === selfId) return false;
        const startedAt = inactiveSince.get(user.presenceId);
        return startedAt === undefined || now - startedAt < COLLABORATOR_IDLE_EXPIRE_MS;
      }),
    );
    updateCollaborators(collaborators);
    scheduleInactivityTransition(users, now);
  };

  const onPresence = (users: Peer[]) => {
    if (!Array.isArray(users)) return;
    lastPresenceUsers = users;
    applyPresence(users, Date.now());
  };

  const onCursor = (data: any) => {
    if (
      typeof data?.presenceId !== "string" ||
      !isCursorPointer(data.pointer) ||
      !knownPresenceIds.has(data.presenceId) ||
      inactiveSince.has(data.presenceId)
    ) {
      return;
    }
    const now = performance.now();
    const existing = api.getAppState().collaborators?.get(data.presenceId) || {};
    const previousTrack = cursorTracks.get(data.presenceId);
    const previousPointer = previousTrack
      ? cursorAt(previousTrack, now).pointer
      : isCursorPointer(existing.pointer)
        ? existing.pointer
        : data.pointer;
    cursorTracks.set(data.presenceId, {
      from: previousPointer,
      target: data.pointer,
      receivedAt: now,
      durationMs: previousTrack || isCursorPointer(existing.pointer) ? CURSOR_INTERPOLATION_MS : 0,
      data: {
        pointer: data.pointer,
        button: data.button || "up",
        username: data.username,
        color: { background: data.color, stroke: data.color },
        id: data.presenceId,
      },
    });
    wake();
  };

  socket.on("presence-update", onPresence);
  socket.on("cursor-move", onCursor);

  const reset = () => {
    selfPresenceId = null;
    lastPresenceUsers = null;
    knownPresenceIds.clear();
    inactiveSince.clear();
    cursorTracks.clear();
    clearInactivityTimer();
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    onPeersChange([]);
    updateCollaborators(new Map());
  };

  /**
   * Re-apply the last presence list.
   *
   * Names are only rebuilt when presence or a cursor arrives. Cursor chat can
   * change what a name should say while its owner sits perfectly still, and
   * without this their message would wait for their next twitch.
   */
  const refresh = () => {
    if (lastPresenceUsers) applyPresence(lastPresenceUsers, Date.now());
  };

  return {
    refresh,
    setSelfPresenceId(presenceId: string) {
      selfPresenceId = presenceId;
      if (lastPresenceUsers) onPresence(lastPresenceUsers);
    },
    reset,
    dispose() {
      socket.off("presence-update", onPresence);
      socket.off("cursor-move", onCursor);
      clearInactivityTimer();
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    },
  };
};
