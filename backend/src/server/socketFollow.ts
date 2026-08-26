import type { Server, Socket } from "socket.io";
import { canViewDrawing, type DrawingAccess } from "../authz/sharing";
import { parseDrawingId, parseSceneBounds, type PresenceUser } from "./socketProtocol";
import { createRoomEventFeedback, type RoomEventAck } from "./socketRoomEvent";
import {
  collaborationEvents,
  followCommandSchema,
  viewportBoundsInputSchema,
} from "@excalidash/domain/collaboration";

type SocketFollowManagerDeps = {
  io: Server;
  connectedSockets: Map<string, Socket>;
  drawingBySocket: Map<string, string>;
  getPresence: (socketId: string) => PresenceUser | null;
  getAccess: (socketId: string, drawingId: string) => Promise<DrawingAccess>;
  requireAccess: (socket: Socket, drawingId: string) => Promise<DrawingAccess | null>;
  removeFromDrawing: (socket: Socket, reason: string) => Promise<void>;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

export const createSocketFollowManager = ({
  io,
  connectedSockets,
  drawingBySocket,
  getPresence,
  getAccess,
  requireAccess,
  removeFromDrawing,
}: SocketFollowManagerDeps) => {
  const followingBySocket = new Map<string, string>();
  const followersBySocket = new Map<string, Set<string>>();
  const viewportSequenceBySocket = new Map<string, number>();
  const followerAccessCache = new Map<
    string,
    { drawingId: string; access: DrawingAccess; expiresAt: number }
  >();
  const FOLLOWER_ACCESS_CACHE_TTL_MS = 1_000;

  // Viewport events are high frequency. Cache only the follower-side read
  // decision; senders still take the normal fresh requireAccess path, and all
  // explicit/periodic revocation checks invalidate this cache before checking.

  const cacheFollowerAccess = (socketId: string, drawingId: string, access: DrawingAccess) => {
    followerAccessCache.set(socketId, {
      drawingId,
      access,
      expiresAt: Date.now() + FOLLOWER_ACCESS_CACHE_TTL_MS,
    });
  };

  const getFollowerAccess = async (socketId: string, drawingId: string) => {
    const cached = followerAccessCache.get(socketId);
    if (cached?.drawingId === drawingId && cached.expiresAt > Date.now()) {
      return cached.access;
    }
    const access = await getAccess(socketId, drawingId);
    cacheFollowerAccess(socketId, drawingId, access);
    return access;
  };

  const invalidateAccess = (socketId?: string) => {
    if (socketId) followerAccessCache.delete(socketId);
    else followerAccessCache.clear();
  };

  const emitFollowedBy = (targetId: string) => {
    const drawingId = drawingBySocket.get(targetId);
    if (!drawingId) return;
    const followers = Array.from(followersBySocket.get(targetId) || [])
      .filter((id) => drawingBySocket.get(id) === drawingId)
      .map(getPresence)
      .filter((user): user is PresenceUser => Boolean(user))
      .map((user) => ({ presenceId: user.presenceId, name: user.name }));
    io.to(targetId).emit(collaborationEvents.followedByUpdate, { drawingId, followers });
  };

  const emitFollowStatus = (socket: Socket, drawingId: string, reason?: string) => {
    const targetId = followingBySocket.get(socket.id);
    socket.emit(collaborationEvents.followStatus, {
      drawingId,
      followingPresenceId:
        targetId && drawingBySocket.get(targetId) === drawingId ? targetId : null,
      ...(reason ? { reason } : {}),
    });
  };

  const clearFollower = (followerId: string, reason: string, notifyFollower: boolean) => {
    const targetId = followingBySocket.get(followerId);
    if (!targetId) return;
    followingBySocket.delete(followerId);
    const followers = followersBySocket.get(targetId);
    followers?.delete(followerId);
    if (followers?.size === 0) followersBySocket.delete(targetId);
    emitFollowedBy(targetId);
    if (!notifyFollower) return;
    const drawingId = drawingBySocket.get(followerId);
    if (drawingId) {
      io.to(followerId).emit("follow-status", {
        drawingId,
        followingPresenceId: null,
        reason,
      });
    }
  };

  const clearSocket = (socketId: string, reason: string) => {
    clearFollower(socketId, reason, false);
    viewportSequenceBySocket.delete(socketId);
    invalidateAccess(socketId);
    const followers = Array.from(followersBySocket.get(socketId) || []);
    followersBySocket.delete(socketId);
    for (const followerId of followers) {
      if (followingBySocket.get(followerId) !== socketId) continue;
      followingBySocket.delete(followerId);
      const drawingId = drawingBySocket.get(followerId);
      if (drawingId) {
        io.to(followerId).emit("follow-status", {
          drawingId,
          followingPresenceId: null,
          reason,
        });
      }
    }
  };

  const wouldCreateCycle = (followerId: string, targetId: string) => {
    const visited = new Set<string>();
    let currentId: string | undefined = targetId;
    while (currentId && !visited.has(currentId)) {
      if (currentId === followerId) return true;
      visited.add(currentId);
      currentId = followingBySocket.get(currentId);
    }
    return false;
  };

  const registerHandlers = (
    socket: Socket,
    allowFollow: () => boolean,
    allowViewport: () => boolean,
    allowUnfollow: () => boolean,
  ) => {
    let followQueue = Promise.resolve();
    let pendingFollowCommands = 0;
    let followCancellationRevision = 0;
    const MAX_PENDING_FOLLOW_COMMANDS = 8;
    const followFeedback = createRoomEventFeedback(
      socket,
      collaborationEvents.followCommand,
      60_000,
    );
    const viewportFeedback = createRoomEventFeedback(
      socket,
      collaborationEvents.viewportBounds,
      1_000,
    );
    socket.on(collaborationEvents.followCommand, (data: unknown, ack?: RoomEventAck) => {
      const drawingId =
        data && typeof data === "object"
          ? parseDrawingId((data as Record<string, unknown>).drawingId)
          : null;
      const reject = (reason: string, message: string) => {
        if (drawingId) emitFollowStatus(socket, drawingId, reason);
        ack?.({ ok: false, error: { code: reason, message } });
      };
      if (!drawingId) {
        followFeedback.invalid(ack);
        return;
      }
      const parsedCommand = followCommandSchema.safeParse(data);
      if (!parsedCommand.success) {
        followFeedback.invalid(ack);
        return;
      }
      const payload = parsedCommand.data;
      if (payload.action === "UNFOLLOW") {
        if (!allowUnfollow()) return;
        // Keep recovery outside the FOLLOW queue so it can still overtake a
        // slow target check, but trust it only after fresh room access.
        const run = async () => {
          if (!(await requireAccess(socket, drawingId))) return;
          // Advancing the revision prevents any already-running FOLLOW from
          // recreating the edge after this cleanup.
          followCancellationRevision += 1;
          clearFollower(socket.id, "unfollowed", false);
          emitFollowStatus(socket, drawingId);
          ack?.({ ok: true });
        };
        return run();
      }
      if (!allowFollow()) {
        if (followFeedback.rateLimited()) emitFollowStatus(socket, drawingId, "rate-limited");
        return;
      }
      if (pendingFollowCommands >= MAX_PENDING_FOLLOW_COMMANDS) {
        reject("queue-full", "Too many pending follow commands");
        return;
      }
      pendingFollowCommands += 1;
      const cancellationRevision = followCancellationRevision;
      const run = async () => {
        const followerAccess = await requireAccess(socket, drawingId);
        if (!followerAccess) return;
        if (cancellationRevision !== followCancellationRevision) return;
        cacheFollowerAccess(socket.id, drawingId, followerAccess);
        const targetId =
          typeof payload.targetPresenceId === "string" && payload.targetPresenceId.length <= 200
            ? payload.targetPresenceId
            : null;
        if (payload.action !== "FOLLOW" || !targetId) {
          followFeedback.invalid(ack);
          return;
        }
        if (targetId === socket.id) {
          emitFollowStatus(socket, drawingId, "self-follow");
          ack?.({
            ok: false,
            error: { code: "invalid-request", message: "Cannot follow your own presence" },
          });
          return;
        }
        const targetSocket = connectedSockets.get(targetId);
        if (
          !targetSocket ||
          drawingBySocket.get(targetId) !== drawingId ||
          !targetSocket.rooms.has(roomName(drawingId))
        ) {
          emitFollowStatus(socket, drawingId, "target-unavailable");
          ack?.({
            ok: false,
            error: { code: "target-unavailable", message: "Follow target is unavailable" },
          });
          return;
        }
        const targetAccess = await getAccess(targetId, drawingId);
        if (cancellationRevision !== followCancellationRevision) return;
        if (
          connectedSockets.get(socket.id) !== socket ||
          drawingBySocket.get(socket.id) !== drawingId
        ) {
          return;
        }
        if (!canViewDrawing(targetAccess)) {
          if (connectedSockets.get(targetId) === targetSocket) {
            await removeFromDrawing(targetSocket, "access-revoked");
          }
          emitFollowStatus(socket, drawingId, "target-unavailable");
          ack?.({
            ok: false,
            error: { code: "target-unavailable", message: "Follow target is unavailable" },
          });
          return;
        }
        if (
          connectedSockets.get(targetId) !== targetSocket ||
          drawingBySocket.get(targetId) !== drawingId ||
          !targetSocket.rooms.has(roomName(drawingId))
        ) {
          emitFollowStatus(socket, drawingId, "target-unavailable");
          ack?.({
            ok: false,
            error: { code: "target-unavailable", message: "Follow target is unavailable" },
          });
          return;
        }
        if (wouldCreateCycle(socket.id, targetId)) {
          emitFollowStatus(socket, drawingId, "cycle-detected");
          ack?.({
            ok: false,
            error: { code: "cycle-detected", message: "Follow cycle detected" },
          });
          return;
        }
        clearFollower(socket.id, "target-changed", false);
        followingBySocket.set(socket.id, targetId);
        const followers = followersBySocket.get(targetId) || new Set<string>();
        followers.add(socket.id);
        followersBySocket.set(targetId, followers);
        emitFollowedBy(targetId);
        emitFollowStatus(socket, drawingId);
        ack?.({ ok: true });
      };
      const result = followQueue.then(run, run);
      followQueue = result.then(
        () => {
          pendingFollowCommands -= 1;
        },
        () => {
          pendingFollowCommands -= 1;
        },
      );
      return result;
    });

    socket.on(collaborationEvents.viewportBounds, async (data: unknown, ack?: RoomEventAck) => {
      if (!allowViewport()) {
        viewportFeedback.rateLimited();
        return;
      }
      const parsed = viewportBoundsInputSchema.safeParse(data);
      const drawingId = parsed.success ? parseDrawingId(parsed.data.drawingId) : null;
      const sceneBounds = parsed.success ? parseSceneBounds(parsed.data.sceneBounds) : null;
      if (!drawingId || !sceneBounds) {
        viewportFeedback.invalid(ack);
        return;
      }
      if (!(await requireAccess(socket, drawingId))) {
        return;
      }
      const sequence = (viewportSequenceBySocket.get(socket.id) || 0) + 1;
      viewportSequenceBySocket.set(socket.id, sequence);
      for (const followerId of Array.from(followersBySocket.get(socket.id) || [])) {
        const followerSocket = connectedSockets.get(followerId);
        if (
          !followerSocket ||
          followingBySocket.get(followerId) !== socket.id ||
          drawingBySocket.get(followerId) !== drawingId ||
          !followerSocket.rooms.has(roomName(drawingId))
        ) {
          clearFollower(followerId, "relationship-invalid", false);
          continue;
        }
        const followerAccess = await getFollowerAccess(followerId, drawingId);
        if (
          connectedSockets.get(followerId) !== followerSocket ||
          followingBySocket.get(followerId) !== socket.id ||
          drawingBySocket.get(followerId) !== drawingId ||
          !followerSocket.rooms.has(roomName(drawingId))
        ) {
          clearFollower(followerId, "relationship-invalid", false);
          continue;
        }
        if (!canViewDrawing(followerAccess)) {
          await removeFromDrawing(followerSocket, "access-revoked");
          continue;
        }
        io.to(followerId).volatile.emit(collaborationEvents.viewportBounds, {
          drawingId,
          presenceId: socket.id,
          sceneBounds,
          sequence,
        });
      }
      viewportFeedback.succeeded(ack);
    });
  };

  return { clearSocket, invalidateAccess, registerHandlers };
};
