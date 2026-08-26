import type { Socket } from "socket.io-client";
import { withLargeSelectionStatus } from "./remoteSelection";
import type { CollaborationCapability } from "../../integrations/excalidraw/capabilities";
import type {
  CollaboratorInfo,
  CollaboratorPatch,
  SocketId,
} from "../../integrations/excalidraw/types";
import {
  collaborationEvents,
  presenceSnapshotSchema,
  remoteCursorUpdateSchema,
  type PresenceIdentity,
} from "@excalidash/domain/collaboration";

export type Peer = PresenceIdentity;

/**
 * Inactive is not gone.
 *
 * NIL-372's root cause, read straight off this file before the fix: a tab
 * losing focus set `isActive: false`, and this file treated that exactly like
 * a real departure -- `collaboration.removeCollaborators`. Excalidraw drops
 * `userToFollow` the moment the person it names leaves the collaborator map,
 * so following someone ended on the first click into a second window, which
 * is the only way to use two browsers on one screen. `presenceRegistry.ts`
 * already got this right server-side: `setActive` only flips a flag and clears
 * the stale selection, `leave` is the only thing that actually removes an
 * entry. This file is the one place that still conflated the two.
 *
 * The suffix a name carries while away is delayed by a grace window so an
 * ordinary alt-tab does not flicker it on and off, and applying no patch at
 * all while inactive is what leaves the cursor frozen at its last position
 * instead of jumping or vanishing -- there is nothing here that would move it.
 */
const AWAY_SUFFIX = " · away";
const AWAY_GRACE_MS = 4_000;

/**
 * Move an away cursor 20% towards its own greyscale value.
 *
 * This keeps four fifths of the participant colour, so the person remains
 * easy to identify. Mixing towards the colour's own luminance instead of a
 * light- or dark-theme token also keeps roughly the same contrast in both
 * themes: away reads quieter, never faded out.
 */
export const AWAY_CURSOR_GRAY_MIX = 0.2;

export const awayCursorColor = (color: string | null): string | null => {
  if (!color) return null;
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return color;
  const channels = match.slice(1).map((channel) => Number.parseInt(channel, 16));
  const grey = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  const muted = channels.map((channel) =>
    Math.round(channel * (1 - AWAY_CURSOR_GRAY_MIX) + grey * AWAY_CURSOR_GRAY_MIX),
  );
  return `#${muted.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
};

export const withAwayStatus = (name: unknown, away: boolean): string => {
  const current = typeof name === "string" && name ? name : "Participant";
  const base = current.endsWith(AWAY_SUFFIX) ? current.slice(0, -AWAY_SUFFIX.length) : current;
  return away ? `${base}${AWAY_SUFFIX}` : base;
};

/**
 * Client-only cursor smoothing (NIL-373's third build item).
 *
 * A sender's own cursor-move emits are throttled to at most one per ~50ms
 * (`lastCursorEmit` in useEditorCollaboration.ts), so a remote cursor drawn
 * only on receipt jumps between those points at ~20fps instead of gliding.
 * `CURSOR_INTERP_MS` matches that throttle: each new position is interpolated
 * to over roughly the same window a real update would take to arrive, so the
 * glide finishes right around when the next one is due -- short enough to
 * add no perceptible lag, long enough to remove the jump.
 *
 * This does not fight the "only run while there is something to draw"
 * invariant on `renderCursors` below -- an interpolation in flight *is*
 * something to draw. The loop still starts on a cursor-move and still stops,
 * exactly when the last tracked cursor has reached its target: nothing here
 * schedules a frame for a cursor sitting still.
 */
const CURSOR_INTERP_MS = 50;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type CursorAnim = {
  from: { x: number; y: number } | null;
  to: { x: number; y: number };
  startedAt: number;
  button: string;
  username: string;
  color: string | null;
};

/** Where this cursor actually is right now: mid-glide, or already arrived. */
const pointAt = (anim: CursorAnim, now: number): { x: number; y: number } => {
  if (!anim.from) return anim.to;
  const progress = Math.min(1, (now - anim.startedAt) / CURSOR_INTERP_MS);
  return { x: lerp(anim.from.x, anim.to.x, progress), y: lerp(anim.from.y, anim.to.y, progress) };
};

export const bindSocketCollaborators = ({
  socket,
  collaboration,
  onPeersChange,
  decorateName = (name) => name,
}: {
  socket: Socket;
  collaboration: CollaborationCapability;
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
  const cursorAnims = new Map<string, CursorAnim>();
  let animationFrameId = 0;
  const awayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const awayPresenceIds = new Set<string>();

  const clearAwayTimer = (presenceId: string) => {
    const timer = awayTimers.get(presenceId);
    if (timer !== undefined) {
      clearTimeout(timer);
      awayTimers.delete(presenceId);
    }
  };

  const forgetAway = (presenceId: string) => {
    clearAwayTimer(presenceId);
    awayPresenceIds.delete(presenceId);
  };

  /** Mark a peer away only after they have stayed inactive for the grace window. */
  const scheduleAway = (presenceId: string) => {
    if (awayTimers.has(presenceId) || awayPresenceIds.has(presenceId)) return;
    awayTimers.set(
      presenceId,
      setTimeout(() => {
        awayTimers.delete(presenceId);
        const peers = currentPeers();
        const peer = peers?.get(presenceId);
        // Gone, or active again, in the time the grace window bought them.
        if (!peer) return;
        awayPresenceIds.add(presenceId);
        write([
          {
            socketId: presenceId as SocketId,
            name: withAwayStatus(peer.name, true),
            color: awayCursorColor(peer.color),
          },
        ]);
      }, AWAY_GRACE_MS),
    );
  };

  /**
   * The room as the editor currently holds it, keyed the way this file thinks.
   *
   * A failed read is not silently an empty room: an empty map here would look
   * like "everybody left" and delete every cursor on the board.
   */
  const currentPeers = (): Map<string, CollaboratorInfo> | null => {
    const read = collaboration.readCollaborators();
    if (!read.ok) return null;
    return new Map(read.value.map((peer) => [String(peer.socketId), peer]));
  };

  const write = (patches: readonly CollaboratorPatch[]) => {
    if (patches.length === 0) return;
    collaboration.patchCollaborators(patches);
  };

  /**
   * Runs only while there is something to draw.
   *
   * It used to schedule the next frame unconditionally, so an idle editor kept
   * a sixty-times-a-second loop alive doing nothing at all. A cursor arriving
   * starts it; every tracked cursor having reached its target lets it stop.
   */
  const renderCursors = () => {
    animationFrameId = 0;
    if (cursorAnims.size === 0) return;
    const peers = currentPeers();
    if (!peers) {
      cursorAnims.clear();
      return;
    }
    const now = Date.now();
    const patches: CollaboratorPatch[] = [];
    let stillAnimating = false;
    cursorAnims.forEach((anim, presenceId) => {
      const existing = peers.get(presenceId);
      const away = awayPresenceIds.has(presenceId);
      patches.push({
        socketId: presenceId as SocketId,
        pointer: pointAt(anim, now),
        pointerButton: anim.button === "down" ? "down" : "up",
        color: away ? awayCursorColor(anim.color) : anim.color,
        name: withAwayStatus(
          withLargeSelectionStatus(
            decorateName(anim.username, presenceId),
            existing?.selectionAllSelected === true,
          ),
          away,
        ),
      });
      if (anim.from && now - anim.startedAt < CURSOR_INTERP_MS) stillAnimating = true;
    });
    write(patches);
    // Kept in the map rather than cleared even once settled: the next
    // cursor-move for this peer reads `to` back out as the glide's starting
    // point, which is what keeps a second move from snapping backward first.
    if (stillAnimating) animationFrameId = requestAnimationFrame(renderCursors);
  };

  const wake = () => {
    if (animationFrameId === 0) animationFrameId = requestAnimationFrame(renderCursors);
  };

  const onPresence = (value: unknown) => {
    const parsed = presenceSnapshotSchema.safeParse(value);
    if (!parsed.success) return;
    const users = parsed.data;
    lastPresenceUsers = users;
    const selfId = selfPresenceId || socket.id;
    onPeersChange(users.filter((user) => user.presenceId !== selfId));
    const peers = currentPeers();
    if (!peers) return;
    const nextPresenceIds = new Set(
      users.filter((user) => user.presenceId !== selfId).map((user) => user.presenceId),
    );

    // Leaving is a removal, not a patch: a patch would merge an empty record
    // back in and leave a nameless cursor sitting on the board. Only real
    // absence from this snapshot counts as leaving -- `isActive: false` is a
    // tab that lost focus, not a connection that closed, and presenceRegistry
    // keeps that entry right up until it truly disconnects (see this file's
    // "Inactive is not gone" comment).
    const gone: SocketId[] = [];
    knownPresenceIds.forEach((presenceId) => {
      if (!nextPresenceIds.has(presenceId)) {
        gone.push(presenceId as SocketId);
        forgetAway(presenceId);
      }
    });
    if (gone.length > 0) collaboration.removeCollaborators(gone);

    const patches: CollaboratorPatch[] = [];
    users.forEach((user) => {
      if (user.presenceId === selfId) return;
      if (!user.isActive) {
        const existing = peers.get(user.presenceId);
        if (!existing) {
          // Never patched before in this session: give them a name and
          // colour immediately rather than leaving them absent from the
          // avatar list until they happen to become active. No grace delay
          // here -- there is no "was active a moment ago" to protect against
          // flicker for someone who has not been seen active at all yet.
          awayPresenceIds.add(user.presenceId);
          patches.push({
            socketId: user.presenceId as SocketId,
            name: withAwayStatus(decorateName(user.name, user.presenceId), true),
            color: awayCursorColor(user.color),
            isSelf: false,
            selectedIds: [],
          });
        } else {
          scheduleAway(user.presenceId);
        }
        // Otherwise: no patch at all. The pointer, colour and name this peer
        // last had while active simply stay put -- a frozen cursor, not a
        // moving or vanishing one.
        return;
      }
      forgetAway(user.presenceId);
      const existing = peers.get(user.presenceId);
      patches.push({
        socketId: user.presenceId as SocketId,
        name: withLargeSelectionStatus(
          decorateName(user.name, user.presenceId),
          existing?.selectionAllSelected === true,
        ),
        color: user.color,
        isSelf: false,
        // Only when the peer is new. Naming it on every presence update would
        // wipe a selection that arrived between two updates.
        ...(existing ? {} : { selectedIds: [] }),
      });
    });
    knownPresenceIds = nextPresenceIds;
    write(patches);
  };

  const onCursor = (value: unknown) => {
    const parsed = remoteCursorUpdateSchema.safeParse(value);
    if (!parsed.success) return;
    const data = parsed.data;
    const target = data.pointer;
    const now = Date.now();
    const existing = cursorAnims.get(data.presenceId);
    cursorAnims.set(data.presenceId, {
      // Glide from wherever this cursor visually is right now -- mid-flight
      // or long settled -- never from the previous target. Starting from the
      // old target on every update would make a fast-moving cursor visibly
      // snap backward each time a new position arrives.
      from: existing ? pointAt(existing, now) : null,
      to: target,
      startedAt: now,
      button: data.button || "up",
      username: data.username,
      // A plain colour, matching what `onPresence` already writes below and
      // what `CollaboratorPatch.color`/`applyPatch` (integrations/excalidraw/
      // collaboration.ts) expect: `applyPatch` is what wraps it into
      // `{background, stroke}` on the raw record. Wrapping it again here --
      // the pre-existing shape this replaces -- fed a `{background, stroke}`
      // object into a field `applyPatch` treats as a single colour string,
      // silently producing a malformed nested colour on every remote cursor.
      color: typeof data.color === "string" ? data.color : null,
    });
    wake();
  };

  socket.on(collaborationEvents.presenceUpdate, onPresence);
  socket.on(collaborationEvents.cursorMove, onCursor);

  const clearAllAwayTimers = () => {
    awayTimers.forEach((timer) => clearTimeout(timer));
    awayTimers.clear();
    awayPresenceIds.clear();
  };

  const reset = () => {
    selfPresenceId = null;
    lastPresenceUsers = null;
    knownPresenceIds.clear();
    cursorAnims.clear();
    clearAllAwayTimers();
    onPeersChange([]);
    const peers = currentPeers();
    if (peers && peers.size > 0) {
      collaboration.removeCollaborators([...peers.keys()] as SocketId[]);
    }
  };

  /**
   * Re-apply the last presence list.
   *
   * Names are only rebuilt when presence or a cursor arrives. Cursor chat can
   * change what a name should say while its owner sits perfectly still, and
   * without this their message would wait for their next twitch.
   */
  const refresh = () => {
    if (lastPresenceUsers) onPresence(lastPresenceUsers);
  };

  return {
    refresh,
    setSelfPresenceId(presenceId: string) {
      selfPresenceId = presenceId;
      if (lastPresenceUsers) onPresence(lastPresenceUsers);
    },
    reset,
    dispose() {
      socket.off(collaborationEvents.presenceUpdate, onPresence);
      socket.off(collaborationEvents.cursorMove, onCursor);
      cancelAnimationFrame(animationFrameId);
      clearAllAwayTimers();
    },
  };
};
