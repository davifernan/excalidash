import type { Socket } from "socket.io-client";
import { withLargeSelectionStatus } from "./remoteSelection";
import type { CollaborationCapability } from "../../integrations/excalidraw/capabilities";
import type {
  CollaboratorInfo,
  CollaboratorPatch,
  SocketId,
} from "../../integrations/excalidraw/types";

export interface Peer {
  presenceId: string;
  // No account id: the server keeps that to itself, because a share link puts
  // anonymous visitors in the same room as everyone else.
  name: string;
  initials: string;
  color: string;
  isActive: boolean;
}

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
  const cursorBuffer = new Map<string, any>();
  let animationFrameId = 0;

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
   * starts it; an empty buffer lets it stop.
   */
  const renderCursors = () => {
    animationFrameId = 0;
    if (cursorBuffer.size > 0) {
      const peers = currentPeers();
      if (!peers) {
        cursorBuffer.clear();
        return;
      }
      const patches: CollaboratorPatch[] = [];
      cursorBuffer.forEach((data, presenceId) => {
        const existing = peers.get(presenceId);
        patches.push({
          socketId: presenceId as SocketId,
          pointer: data.pointer ?? null,
          pointerButton: data.button === "down" ? "down" : "up",
          color: data.color ?? null,
          name: withLargeSelectionStatus(
            decorateName(data.username, presenceId),
            existing?.selectionAllSelected === true,
          ),
        });
      });
      cursorBuffer.clear();
      write(patches);
      // One more frame, in case cursors arrived while this one was drawing.
      animationFrameId = requestAnimationFrame(renderCursors);
    }
  };

  const wake = () => {
    if (animationFrameId === 0) animationFrameId = requestAnimationFrame(renderCursors);
  };

  const onPresence = (users: Peer[]) => {
    if (!Array.isArray(users)) return;
    lastPresenceUsers = users;
    const selfId = selfPresenceId || socket.id;
    onPeersChange(users.filter((user) => user.presenceId !== selfId));
    const peers = currentPeers();
    if (!peers) return;
    const nextPresenceIds = new Set(
      users.filter((user) => user.presenceId !== selfId).map((user) => user.presenceId),
    );

    // Leaving is a removal, not a patch: a patch would merge an empty record
    // back in and leave a nameless cursor sitting on the board.
    const gone: SocketId[] = [];
    knownPresenceIds.forEach((presenceId) => {
      if (!nextPresenceIds.has(presenceId)) gone.push(presenceId as SocketId);
    });
    users.forEach((user) => {
      if (user.presenceId !== selfId && !user.isActive) gone.push(user.presenceId as SocketId);
    });
    if (gone.length > 0) collaboration.removeCollaborators(gone);

    const patches: CollaboratorPatch[] = [];
    users.forEach((user) => {
      if (user.presenceId === selfId || !user.isActive) return;
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

  const onCursor = (data: any) => {
    if (typeof data?.presenceId !== "string") return;
    cursorBuffer.set(data.presenceId, {
      pointer: data.pointer,
      button: data.button || "up",
      username: data.username,
      color: { background: data.color, stroke: data.color },
      id: data.presenceId,
    });
    wake();
  };

  socket.on("presence-update", onPresence);
  socket.on("cursor-move", onCursor);

  const reset = () => {
    selfPresenceId = null;
    lastPresenceUsers = null;
    knownPresenceIds.clear();
    cursorBuffer.clear();
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
      socket.off("presence-update", onPresence);
      socket.off("cursor-move", onCursor);
      cancelAnimationFrame(animationFrameId);
    },
  };
};
