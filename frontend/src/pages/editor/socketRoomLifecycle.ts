import type { Socket } from "socket.io-client";
import type { UserIdentity } from "../../utils/identity";
import { collaborationEvents, joinRoomAckSchema } from "@excalidash/domain/collaboration";

type JoinedPresence = {
  presenceId: string;
  name?: string;
  initials?: string;
  color?: string;
};

const JOIN_ACK_TIMEOUT_MS = 2_000;
const JOIN_RETRY_DELAY_MS = 250;

export const bindSocketRoomLifecycle = ({
  socket,
  drawingId,
  shareToken,
  user,
  resetConnectionState,
  onJoined,
  getFollowTargetPresenceId,
}: {
  socket: Socket;
  drawingId: string;
  shareToken: string | null;
  user: UserIdentity;
  resetConnectionState: () => void;
  onJoined: (presence: JoinedPresence) => void;
  getFollowTargetPresenceId: () => string | null;
}) => {
  let joinedSocketId: string | null = null;
  let joiningSocketId: string | null = null;
  let resetSocketId: string | null = null;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Clearing the connection state empties the collaborator list, and Excalidraw
  // drops userToFollow as soon as the person being followed leaves it. Reading
  // the target after that always yields null, which made the restore below dead
  // code: a two second blip ended follow even though the other person never
  // went anywhere. So the target is captured while it can still be read.
  let rememberedTarget: string | null = null;
  const rememberTarget = () => {
    const current = getFollowTargetPresenceId();
    if (current) rememberedTarget = current;
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer !== null) clearTimeout(timer);
  };

  const scheduleRetry = (socketId: string) => {
    clearTimer(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!disposed && socket.connected && socket.id === socketId) {
        joinCurrentConnection();
      }
    }, JOIN_RETRY_DELAY_MS);
  };

  const joinCurrentConnection = () => {
    const socketId = socket.id;
    if (!socketId || disposed || joinedSocketId === socketId || joiningSocketId === socketId) {
      return;
    }
    if (resetSocketId !== socketId) {
      resetSocketId = socketId;
      rememberTarget();
      resetConnectionState();
    }
    joiningSocketId = socketId;
    let settled = false;
    clearTimer(ackTimer);
    ackTimer = setTimeout(() => {
      if (settled || socket.id !== socketId) return;
      settled = true;
      joiningSocketId = null;
      scheduleRetry(socketId);
    }, JOIN_ACK_TIMEOUT_MS);
    socket.emit(
      collaborationEvents.joinRoom,
      { drawingId, shareToken, user },
      (payload: unknown) => {
        if (settled || socket.id !== socketId) return;
        settled = true;
        clearTimer(ackTimer);
        ackTimer = null;
        joiningSocketId = null;
        const parsed = joinRoomAckSchema.safeParse(payload);
        if (!parsed.success) {
          scheduleRetry(socketId);
          return;
        }
        if ("error" in parsed.data) {
          if (parsed.data.error.code !== "access-denied") scheduleRetry(socketId);
          return;
        }
        const presence = parsed.data.presence;
        joinedSocketId = socketId;
        onJoined(presence);
        const targetPresenceId = getFollowTargetPresenceId() || rememberedTarget;
        rememberedTarget = null;
        if (targetPresenceId) {
          socket.emit(collaborationEvents.followCommand, {
            drawingId,
            targetPresenceId,
            action: "FOLLOW",
          });
        }
      },
    );
  };

  const onDisconnect = () => {
    rememberTarget();
    clearTimer(ackTimer);
    clearTimer(retryTimer);
    ackTimer = null;
    retryTimer = null;
    joinedSocketId = null;
    joiningSocketId = null;
    resetSocketId = null;
    resetConnectionState();
  };

  socket.on("connect", joinCurrentConnection);
  socket.on("disconnect", onDisconnect);
  if (socket.connected) joinCurrentConnection();

  return () => {
    disposed = true;
    clearTimer(ackTimer);
    clearTimer(retryTimer);
    socket.off("connect", joinCurrentConnection);
    socket.off("disconnect", onDisconnect);
  };
};
