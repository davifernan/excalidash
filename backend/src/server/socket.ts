import type { Server, Socket } from "socket.io";
import type { PrismaClient } from "../generated/client";
import type { BoardAgentRunAudience } from "../agent/presence";
import type { AuthModeService } from "../auth/authMode";
import { logger } from "../logger";
import {
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
  parseShareLinkToken,
  type DrawingPrincipal,
} from "../authz/sharing";
import { getDrawingCapabilities } from "../authz/capabilities";
import { createSocketAuthenticator } from "./socketAuth";
import {
  createCollaborationAccessController,
  type CollaborationAccessController,
} from "./collaborationAccess";
import { createSocketFollowManager } from "./socketFollow";
import {
  createApiKeySocketRevoker,
  registerApiKeySocketRevoker,
  registerUserSocketRechecker,
} from "./socketRevocation";
import { DRAWINGS_READ_SCOPE, DRAWINGS_WRITE_SCOPE } from "../auth/apiKeys";
import { startNonOverlappingSocketAccessSweep } from "./socketAccessSweep";
import { createSocketCredentialGuard } from "./socketCredentials";
import {
  derivePresenceColor,
  deriveGuestName,
  emitBoardAgentPresenceSnapshotToSocket,
  emitBoardAgentPresenceSnapshots,
  BOARD_AGENT_PRESENCE_STALE_MS,
  toPresenceColor,
  toPresenceInitials,
  toPresenceName,
} from "./socketPresence";
import {
  PresenceRegistry,
  toPublicPresence,
  type PresenceEntry,
  type PresenceKind,
} from "./presenceRegistry";
import {
  createKeyedByteLimiter,
  createKeyedRateLimiter,
  createRateLimiter,
  parseDrawingId,
  ELEMENT_UPDATE_TRAFFIC_LIMITS,
  type ElementUpdateTrafficLimits,
  SOCKET_LIMITS,
  SOCKET_QUEUE_LIMITS,
} from "./socketProtocol";
import { ActiveAccountCache } from "./activeAccountCache";
import { grantDrawingAccessFromLink } from "../authz/grants";
import { getDrawingMembership } from "../authz/membership";
import { ipKeyGenerator } from "express-rate-limit";
import { resolveSocketClientAddress, type TrustProxySetting } from "./socketClientAddress";
import { registerCoreRoomEvents } from "./socketCoreRoomEvents";
import {
  registerSelectionRoomEvent,
  SELECTION_LIMITS,
  SELECTION_SNAPSHOT_EVENT,
} from "./socketSelection";
import { registerCursorChatRoomEvent, CURSOR_CHAT_LIMITS } from "./socketCursorChat";
import { createWorkshopTimerManager, registerWorkshopTimerRoomEvent } from "./socketWorkshopTimer";
import { DRAWING_NAME_EVENT, loadDrawingNameSnapshot } from "./socketDrawingName";
import {
  createDocumentPageManager,
  DOCUMENT_PAGE_EVENT,
  registerDocumentPageRoomEvent,
} from "./socketDocumentPages";
import { createSocketInviteHereManager } from "./socketInviteHere";
import { createRoomEventFeedback, type RoomEventAck } from "./socketRoomEvent";
import { deriveAssetPageCount } from "../assets/documentPageCount";
import { PresenterRegistry } from "./presenterRegistry";
import { createSocketPresenterManager, PRESENTER_STATE_EVENT } from "./socketPresenter";
import { VotingRegistry } from "./votingRegistry";
import { createSocketVotingManager, VOTING_STATE_EVENT } from "./socketVoting";
import { DocumentEditLockRegistry } from "./documentEditLocks";
import {
  documentEditLockSnapshot,
  DOCUMENT_EDIT_LOCK_EVENT,
  registerDocumentEditLockRoomEvent,
} from "./socketDocumentEditLocks";
import {
  documentEditDraftSnapshot,
  DOCUMENT_EDIT_DRAFT_EVENT,
  DOCUMENT_EDIT_DRAFT_LIMITS,
  registerDocumentEditDraftRoomEvent,
} from "./socketDocumentEditDrafts";
import { drawingCommentsRoomName } from "./socketRoomNames";
import { recordSuccessfulElementMutation } from "../agent/elementGuestProvenance";
import {
  AgentContextGuestWriteDeniedError,
  assertGuestElementWriteAllowed,
} from "../agent/boardContexts";

type RegisterSocketHandlersDeps = {
  io: Server;
  prisma: PrismaClient;
  authModeService: AuthModeService;
  jwtSecret: string;
  accessRecheckIntervalMs?: number;
  /** Shared with the HTTP side so the dashboard can read presence too. */
  presences?: PresenceRegistry;
  elementUpdateTrafficLimits?: ElementUpdateTrafficLimits;
  /**
   * The same setting the HTTP side uses. Without it every socket behind a
   * reverse proxy reports the proxy's address -- and shares one budget.
   */
  trustProxy?: TrustProxySetting;
  /** Required by production; optional in socket-only tests with no stored assets. */
  assetStorageDir?: string;
  documentEditLocks?: DocumentEditLockRegistry;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

export const registerSocketHandlers = ({
  io,
  prisma,
  authModeService,
  jwtSecret,
  accessRecheckIntervalMs = 5_000,
  presences = new PresenceRegistry(),
  elementUpdateTrafficLimits = ELEMENT_UPDATE_TRAFFIC_LIMITS,
  trustProxy = false,
  assetStorageDir,
  documentEditLocks = new DocumentEditLockRegistry(),
}: RegisterSocketHandlersDeps): CollaborationAccessController => {
  const principals = new Map<string, DrawingPrincipal>();
  const connectedSockets = new Map<string, Socket>();
  const credentialChecks = new Map<string, Promise<boolean>>();
  const drawingBySocket = new Map<string, string>();
  // Keyed by who, not by which connection: a per-socket budget for activity
  // pings resets on reconnect, and reconnecting is free.
  // Budgets that outlive a connection. Everything a client can repeat by
  // opening another tab belongs here: the tab is free, the budget must not be.
  // Joining and following stay per connection on purpose -- those refuse
  // somebody outright, and an office behind one address is one actor here.
  const allowActivity = createKeyedRateLimiter(20, 10_000);
  // Four times the per-connection allowance: two tabs and a phone are normal,
  // fifty connections are not, and the point is to stop the budget growing with
  // them rather than to punish a second window.
  const allowCursorMove = createKeyedRateLimiter(40 * 4, 1_000);
  const allowElementUpdateEvents = createKeyedRateLimiter(120 * 4, 1_000);
  // The old two 10k-key maps allowed 20k live buckets total. Actor+board keys
  // multiply faster, so four 5k-key maps retain that same 20k worst case; each
  // map purges expired windows and refuses new keys rather than evicting a live
  // bucket that an attacker could then recreate with a reset budget.
  const elementBudgetMaxKeys = 5_000;
  const allowAccountBoardElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.accountBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );
  const allowAnonymousBoardElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.anonymousBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );
  const allowAccountActorElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.accountActorBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );
  const allowAnonymousActorElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.anonymousActorBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );

  const allowSelection = createKeyedRateLimiter(SELECTION_LIMITS.eventsPerSecond * 4, 1_000);
  const allowCursorChat = createKeyedRateLimiter(CURSOR_CHAT_LIMITS.eventsPerSecond * 4, 1_000);
  const allowDocumentEditDraft = createKeyedRateLimiter(
    DOCUMENT_EDIT_DRAFT_LIMITS.eventsPerSecond * 4,
    1_000,
  );
  const shareTokenBySocket = new Map<string, string>();
  // Authorization provenance captured at the successful join. Presence.kind
  // is presentation: auth-disabled bootstrap sessions deliberately render as
  // guests while remaining the local owner identity, so it must never answer
  // this question.
  const joinedAsGuestBySocket = new Map<string, boolean>();
  const workshopTimers = createWorkshopTimerManager({ io });
  const presenters = new PresenterRegistry();
  const voting = new VotingRegistry();
  const documentPages = createDocumentPageManager({
    io,
    prisma,
    resolvePageCount: assetStorageDir
      ? (assetId) => deriveAssetPageCount(prisma, assetStorageDir, assetId)
      : undefined,
  });
  let followManager: ReturnType<typeof createSocketFollowManager>;
  let inviteHereManager: ReturnType<typeof createSocketInviteHereManager>;
  let presenterManager: ReturnType<typeof createSocketPresenterManager>;
  const activeAccounts = new ActiveAccountCache(async (userId) => {
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    return Boolean(account?.isActive);
  });

  io.use(createSocketAuthenticator({ prisma, authModeService, jwtSecret, principals }));

  const emitPresence = (drawingId: string) => {
    const apiKeySocketIds = Array.from(drawingBySocket.entries())
      .filter(
        ([socketId, currentDrawingId]) =>
          currentDrawingId === drawingId && Boolean(principals.get(socketId)?.apiKey),
      )
      .map(([socketId]) => socketId);
    // Every Socket.IO connection already owns a private room named after its
    // socket id. Excluding those rooms preserves the one collaboration-room
    // lifecycle used by drawing updates and avoids a second presence-only room
    // that every join, leave, board switch, revoke, and disconnect must maintain.
    const recipients = apiKeySocketIds.length
      ? io.to(roomName(drawingId)).except(apiKeySocketIds)
      : io.to(roomName(drawingId));
    recipients.emit("presence-update", presences.listPublic(drawingId));
  };

  const emitDocumentEditLocks = (drawingId: string) => {
    io.to(roomName(drawingId)).emit(
      DOCUMENT_EDIT_LOCK_EVENT,
      documentEditLockSnapshot(documentEditLocks, drawingId),
    );
  };

  const getPresence = (socketId: string): PresenceEntry | null => {
    const drawingId = drawingBySocket.get(socketId);
    return drawingId ? presences.get(drawingId, socketId) : null;
  };

  /**
   * The person behind a socket, or nothing.
   *
   * An automation may read and write board data; it does not act socially. The
   * registry projections already exclude it, but the live socket paths -- the
   * moving cursor, a live selection, follow, invite-here, presenter -- read a
   * presence directly and put its name and colour on other people's screens
   * without ever consulting those projections.
   *
   * Rather than a fifth `if (actor !== "human")` scattered across five
   * handlers, the distinction lives here and the wiring below decides which
   * modules get which accessor. Every one of those handlers already begins
   * with `if (!presence) return;`, so nothing gains a branch -- and a module
   * wired to the wrong accessor is visible at the wiring, in one place.
   *
   * Document edit locks deliberately keep `getPresence`: holding a lock is
   * work, not a social act, and an agent editing a document must be able to.
   */
  const getSocialPresence = (socketId: string): PresenceEntry | null => {
    const presence = getPresence(socketId);
    return presence?.actor === "human" ? presence : null;
  };

  const removeFromDrawing = async (socket: Socket, reason: string, leaveSocketRoom = true) => {
    const drawingId = drawingBySocket.get(socket.id);
    shareTokenBySocket.delete(socket.id);
    joinedAsGuestBySocket.delete(socket.id);
    if (!drawingId) return;
    const lockDrawings = documentEditLocks.releasePresence(socket.id);
    followManager.clearSocket(socket.id, reason);
    inviteHereManager.clearSocket(socket.id, drawingId);
    presenterManager.clearSocket(socket.id, drawingId);
    drawingBySocket.delete(socket.id);
    presences.leave(drawingId, socket.id);
    if (presences.list(drawingId).length === 0) {
      workshopTimers.clear(drawingId);
      presenters.clear(drawingId);
      voting.clear(drawingId);
    }
    if (leaveSocketRoom) {
      await Promise.all([
        socket.leave(roomName(drawingId)),
        socket.leave(drawingCommentsRoomName(drawingId)),
      ]);
    }
    emitPresence(drawingId);
    lockDrawings.forEach(emitDocumentEditLocks);
  };

  const getAccess = (socketId: string, drawingId: string, shareToken?: string | null) =>
    getDrawingAccess({
      prisma,
      principal: principals.get(socketId) || null,
      drawingId,
      isUserActive: (userId) => activeAccounts.get(userId),
      shareToken: shareToken === undefined ? shareTokenBySocket.get(socketId) : shareToken,
    });

  const getCapabilities = (socketId: string, drawingId: string, shareToken?: string | null) =>
    getDrawingCapabilities({
      prisma,
      principal: principals.get(socketId) || null,
      drawingId,
      isUserActive: (userId) => activeAccounts.get(userId),
      shareToken: shareToken === undefined ? shareTokenBySocket.get(socketId) : shareToken,
    });

  const syncCommentRoom = async (
    socket: Socket,
    drawingId: string,
    viewComments: boolean,
  ): Promise<void> => {
    const commentsRoom = drawingCommentsRoomName(drawingId);
    if (viewComments) await socket.join(commentsRoom);
    else await socket.leave(commentsRoom);
  };

  const apiKeyHasScope = (socketId: string, scope: string) => {
    const apiKey = principals.get(socketId)?.apiKey;
    return !apiKey || apiKey.scopes.includes(scope);
  };

  const canSocketView = (socketId: string, access: Awaited<ReturnType<typeof getAccess>>) =>
    canViewDrawing(access) && apiKeyHasScope(socketId, DRAWINGS_READ_SCOPE);

  const canSocketEdit = (socketId: string, access: Awaited<ReturnType<typeof getAccess>>) =>
    canEditDrawing(access) && apiKeyHasScope(socketId, DRAWINGS_WRITE_SCOPE);

  const requireAccess = async (socket: Socket, drawingId: string, requireEdit = false) => {
    if (drawingBySocket.get(socket.id) !== drawingId || !socket.rooms.has(roomName(drawingId))) {
      return null;
    }
    if (!(await credentialChecks.get(socket.id))) return null;
    const access = await getAccess(socket.id, drawingId);
    if (
      connectedSockets.get(socket.id) !== socket ||
      drawingBySocket.get(socket.id) !== drawingId ||
      !socket.rooms.has(roomName(drawingId))
    ) {
      return null;
    }
    if (!canSocketView(socket.id, access)) {
      await removeFromDrawing(socket, "access-revoked");
      socket.emit("error", { message: "You do not have access to this drawing" });
      return null;
    }
    if (requireEdit && !canSocketEdit(socket.id, access)) {
      socket.emit("error", { message: "Read-only access: cannot edit this drawing" });
      return null;
    }
    return access;
  };

  followManager = createSocketFollowManager({
    io,
    connectedSockets,
    drawingBySocket,
    getPresence: getSocialPresence,
    getAccess,
    requireAccess: (socket, drawingId) => requireAccess(socket, drawingId),
    removeFromDrawing: (socket, reason) => removeFromDrawing(socket, reason),
  });
  inviteHereManager = createSocketInviteHereManager({
    connectedSockets,
    getPresence: getSocialPresence,
    requireAccess,
  });
  presenterManager = createSocketPresenterManager({
    io,
    presenters,
    getPresence: getSocialPresence,
    requireAccess,
  });
  const votingManager = createSocketVotingManager({ io, voting, requireAccess });

  const disconnectApiKey = createApiKeySocketRevoker({
    connectedSockets,
    principals,
    removeFromDrawing,
  });
  const credentialGuard = createSocketCredentialGuard({
    prisma,
    connectedSockets,
    principals,
    removeFromDrawing,
    disconnectApiKey,
  });

  io.on("connection", (socket) => {
    // Registration precedes the final credential read. A concurrent revoke
    // must therefore either find this socket in the map or win the final read;
    // there is no gap in which both mechanisms can miss it.
    connectedSockets.set(socket.id, socket);
    const credentialCheck = credentialGuard.verifyRegisteredSocket(socket);
    credentialChecks.set(socket.id, credentialCheck);
    // A per-account room, independent of which drawing (if any) is open, so
    // a mention/reply/resolve notification reaches someone even while they
    // are elsewhere in the app. Never joined by a link-only guest: it has no
    // account to notify, only a per-connection presence identity.
    const notifyPrincipal = principals.get(socket.id);
    if (notifyPrincipal?.kind === "user" && !notifyPrincipal.allowInactive) {
      void socket.join(`user_${notifyPrincipal.userId}`);
    }
    let joinRevision = 0;
    let joinQueue = Promise.resolve();
    let pendingJoins = 0;
    // Who a shared budget belongs to. An account is itself; anyone else is
    // their address, normalised the way the HTTP limiter does it -- a raw
    // address hands anyone with an IPv6 range a fresh budget per connection.
    const actorKey = () => {
      const principal = principals.get(socket.id);
      return principal && !principal.allowInactive
        ? `account:${principal.userId}`
        : // Resolved the way Express resolves req.ip. Behind a proxy the raw
          // handshake address is the proxy for everyone, which would hand every
          // anonymous visitor one shared budget.
          `address:${ipKeyGenerator(resolveSocketClientAddress(socket.handshake, trustProxy)) || "unknown"}`;
    };
    const allowJoin = createRateLimiter(10, 60_000);
    const leaveRoomFeedback = createRoomEventFeedback(socket, "leave-room", 60_000);
    const allowFollow = createRateLimiter(12, 60_000);
    const allowViewport = createRateLimiter(30, 1_000);
    // Unfollowing has its own budget: it returns before the shared seam so it
    // can still overtake a slow follow and cancel it, which means it would
    // otherwise be the one room event with no limit at all.
    const allowUnfollow = createRateLimiter(12, 60_000);
    followManager.registerHandlers(socket, allowFollow, allowViewport, allowUnfollow);
    const allowPresenterCommand = createRateLimiter(20, 60_000);
    const allowPresenterViewport = createRateLimiter(30, 1_000);
    presenterManager.registerHandlers(socket, allowPresenterCommand, allowPresenterViewport);
    const allowVotingCommand = createRateLimiter(20, 60_000);
    const allowVotingCast = createRateLimiter(20, 10_000);
    votingManager.registerHandlers(socket, allowVotingCommand, allowVotingCast);
    registerCoreRoomEvents({
      socket,
      getPresence: getSocialPresence,
      requireAccess,
      setActive: (drawingId, presenceId, active) =>
        presences.setActive(drawingId, presenceId, active),
      emitPresence,
      allowActivity: () => allowActivity(actorKey()),
      allowCursorMove: () => allowCursorMove(actorKey()),
      allowElementUpdate: (drawingId, serializedBytes) => {
        const key = actorKey();
        if (!allowElementUpdateEvents(key)) return false;
        // Rate is not the only unit that matters: 120 small updates a second
        // are harmless and 120 large ones are not. Budgets are per actor and
        // board, with an overall cap so that opening more boards cannot buy
        // unlimited throughput.
        const boardKey = JSON.stringify([key, drawingId]);
        if (key.startsWith("account:")) {
          return (
            allowAccountBoardElementBytes(boardKey, serializedBytes) &&
            allowAccountActorElementBytes(key, serializedBytes)
          );
        }
        if (serializedBytes > SOCKET_LIMITS.anonymousElementUpdateBytes) return false;
        return (
          allowAnonymousBoardElementBytes(boardKey, serializedBytes) &&
          allowAnonymousActorElementBytes(key, serializedBytes)
        );
      },
      authorizeFileDelta: async (drawingId) => {
        const decision = await getCapabilities(socket.id, drawingId);
        return decision.capabilities.uploadFiles;
      },
      recordElementProvenance: async ({ drawingId, elements }) => {
        const decision = await getCapabilities(socket.id, drawingId);
        if (!canSocketEdit(socket.id, decision.access)) {
          throw new Error("Element provenance authorization changed before admission");
        }
        // Member traffic cannot clear an existing fact and needs no socket-side
        // row: member-created elements receive their known-clean row in the
        // version-checked persistence transaction. Guest traffic cannot wait
        // for that later save, because a member may be the client that performs
        // it; the source actor would already be lost by then.
        // Once this connection has entered as a guest, a concurrent promotion
        // cannot retroactively make the already-originated event a member
        // write. Conversely, a member whose standing grant was just removed
        // is caught by the fresh capability decision. Either guest signal is
        // therefore sufficient; neither transition opens a TOCTOU wash.
        const isGuest = joinedAsGuestBySocket.get(socket.id) === true || decision.isGuest;
        if (!isGuest) return;
        // `elementOrder` is the sender's complete live-board order whenever
        // that signature changes. It is synchronization metadata, not a
        // mutation set: treating it as changed ids would mark every existing
        // member element guest-touched after one guest insertion. Provenance
        // follows only the element deltas carried by this event.
        const changedElementIds = elements.flatMap((element) =>
          element && typeof element === "object" && typeof (element as any).id === "string"
            ? [(element as any).id as string]
            : [],
        );
        // Best-effort here, not the guarantee: this event's `elements` is
        // only the delta the sender is applying, not the full board, so an
        // indirect frameId chain through an ancestor frame outside the delta
        // cannot be resolved. A direct write into a registered Context frame
        // -- the realistic attack -- is still caught. executeAgentBoardTool's
        // context-eligibility filter is what actually protects the agent
        // regardless of what slips past this check.
        try {
          await assertGuestElementWriteAllowed({
            prisma,
            drawingId,
            isGuest: true,
            changedElementIds,
            elements,
          });
        } catch (error) {
          if (error instanceof AgentContextGuestWriteDeniedError) {
            return {
              code: "AGENT_CONTEXT_GUEST_WRITE_DENIED",
              message: error.message,
            };
          }
          throw error;
        }
        await recordSuccessfulElementMutation({
          prisma,
          drawingId,
          isGuest: true,
          changedElementIds,
          createdElementIds: [],
        });
      },
    });
    registerSelectionRoomEvent({
      socket,
      presences,
      requireAccess,
      allow: () => allowSelection(actorKey()),
    });
    registerCursorChatRoomEvent({
      socket,
      requireAccess,
      allow: () => allowCursorChat(actorKey()),
    });
    registerWorkshopTimerRoomEvent({ socket, timers: workshopTimers, requireAccess });
    registerDocumentPageRoomEvent({ socket, pages: documentPages, requireAccess });
    registerDocumentEditLockRoomEvent({
      io,
      socket,
      prisma,
      locks: documentEditLocks,
      getPresence,
      requireAccess,
    });
    registerDocumentEditDraftRoomEvent({
      socket,
      locks: documentEditLocks,
      requireAccess,
      allow: () => allowDocumentEditDraft(actorKey()),
    });
    inviteHereManager.registerHandlers(socket);

    socket.on("join-room", (data: unknown, ack?: (value: unknown) => void) => {
      const rejectJoin = (code: string, message: string) => {
        const error = { code, message };
        socket.emit("error", error);
        ack?.({ ok: false, error });
      };
      if (!allowJoin()) {
        rejectJoin("rate-limited", "Join room rate limit exceeded");
        return;
      }
      if (!data || typeof data !== "object") {
        rejectJoin("invalid-request", "Invalid join room request");
        return;
      }
      const payload = data as Record<string, unknown>;
      const drawingId = parseDrawingId(payload.drawingId);
      const shareToken = parseShareLinkToken(payload.shareToken);
      if (!drawingId) {
        rejectJoin("invalid-request", "Invalid drawing id");
        return;
      }
      if (pendingJoins >= SOCKET_QUEUE_LIMITS.joins) {
        rejectJoin("queue-full", "Too many pending join room requests");
        return;
      }
      pendingJoins += 1;
      const revision = ++joinRevision;
      const run = async () => {
        const isCurrentJoin = () =>
          connectedSockets.get(socket.id) === socket && revision === joinRevision;

        if (!(await credentialCheck) || !isCurrentJoin()) {
          ack?.({
            ok: false,
            error: {
              code: "authentication-failed",
              message: "Authentication failed",
            },
          });
          return;
        }
        const decision = await getCapabilities(socket.id, drawingId, shareToken);
        const { access } = decision;
        if (!isCurrentJoin()) return;
        if (!canSocketView(socket.id, access)) {
          socket.emit("error", { message: "You do not have access to this drawing" });
          ack?.({
            ok: false,
            error: {
              code: "access-denied",
              message: "You do not have access to this drawing",
            },
          });
          return;
        }
        const previousDrawingId = drawingBySocket.get(socket.id);
        if (previousDrawingId && previousDrawingId !== drawingId) {
          await removeFromDrawing(socket, "board-changed");
          if (!isCurrentJoin()) return;
        }
        const clientUser =
          payload.user && typeof payload.user === "object"
            ? (payload.user as Record<string, unknown>)
            : {};
        const principal = principals.get(socket.id) || null;
        // Auth switched off gives every visitor the same standing identity,
        // which is another way of saying nobody has one. That is the only case
        // where the browser's own name and colour are all anyone has -- and it
        // is told apart by allowInactive, which the authenticator sets for
        // exactly that principal. The bootstrap *id* is no signal: once auth is
        // on, it belongs to a real administrator with a real name.
        const isSharedBootstrapIdentity = principal?.allowInactive === true;
        const isAccount = Boolean(principal?.userId) && !isSharedBootstrapIdentity;
        let name = toPresenceName(clientUser.name);
        let color = derivePresenceColor(socket.id);
        let kind: PresenceKind = "guest";
        let membershipLevel =
          isAccount && principal
            ? access === "owner"
              ? "owner"
              : (await getDrawingMembership({ prisma, userId: principal.userId, drawingId }))?.level
            : null;
        if (!isCurrentJoin()) return;
        // A signed-in person who arrives through a valid share link becomes a
        // named member of this board, at the link's own level.
        //
        // Until now they stayed anonymous: the branch below gives an account
        // reaching a board only through a link a per-connection guest identity,
        // so their name never appeared next to their cursor and the history
        // could not say who changed what -- though the server knew who they
        // were the whole time.
        //
        // The link still decides what they may do. This only decides whether
        // they have a name while doing it.
        // "owner" is excluded by construction -- an owner already has a
        // membership above, so this branch never sees one -- but the check is
        // written out rather than assumed, because the day it stops being true
        // is the day an owner's level would be rewritten to a link's.
        const linkLevel =
          access === "view" || access === "comment" || access === "edit" ? access : null;
        if (isAccount && principal && shareToken && !membershipLevel && linkLevel) {
          await grantDrawingAccessFromLink({
            db: prisma,
            drawingId,
            userId: principal.userId,
            permission: linkLevel,
          });
          if (!isCurrentJoin()) return;
          membershipLevel = linkLevel;
        }
        if (membershipLevel && principal) {
          // A standing membership has a name the server can check. An account
          // arriving only through a link is still a guest, so the server gives
          // it a per-connection guest identity instead of exposing its account.
          const account = await prisma.user.findUnique({
            where: { id: principal.userId },
            select: { name: true },
          });
          if (!isCurrentJoin()) return;
          if (account) name = toPresenceName(account.name);
          color = derivePresenceColor(principal.userId);
          kind = membershipLevel === "owner" ? "owner" : "member";
        } else if (isSharedBootstrapIdentity) {
          color = toPresenceColor(clientUser.color);
        } else {
          name = deriveGuestName(socket.id);
        }
        await socket.join(roomName(drawingId));
        await syncCommentRoom(socket, drawingId, decision.capabilities.viewComments);
        if (!isCurrentJoin()) {
          await socket.leave(roomName(drawingId));
          await socket.leave(drawingCommentsRoomName(drawingId));
          return;
        }
        const presence: PresenceEntry = {
          presenceId: socket.id,
          accountId: principal?.userId || null,
          name,
          initials: toPresenceInitials(name),
          color,
          kind,
          isActive: true,
          selectedElementIds: {},
          allSelected: false,
          // The one place this is decided. Everything downstream -- the roster,
          // the selection snapshot, the board summary, agent event routing --
          // derives from it instead of re-deriving it from `principal.apiKey`.
          actor: principal?.apiKey ? "automation" : "human",
        };
        drawingBySocket.set(socket.id, drawingId);
        joinedAsGuestBySocket.set(socket.id, decision.isGuest);
        if (shareToken) shareTokenBySocket.set(socket.id, shareToken);
        else shareTokenBySocket.delete(socket.id);
        presences.join(drawingId, presence);
        emitPresence(drawingId);
        emitBoardAgentPresenceSnapshotToSocket({
          io,
          presences,
          drawingId,
          presenceId: socket.id,
        });
        socket.emit(SELECTION_SNAPSHOT_EVENT, presences.selectionSnapshot(drawingId));
        socket.emit("workshop-timer-update", workshopTimers.snapshot(drawingId));
        socket.emit(PRESENTER_STATE_EVENT, presenters.snapshot(drawingId));
        socket.emit(VOTING_STATE_EVENT, voting.snapshot(drawingId));
        socket.emit(
          DOCUMENT_EDIT_LOCK_EVENT,
          documentEditLockSnapshot(documentEditLocks, drawingId),
        );
        socket.emit(
          DOCUMENT_EDIT_DRAFT_EVENT,
          documentEditDraftSnapshot(documentEditLocks, drawingId),
        );
        const drawingNameSnapshot = await loadDrawingNameSnapshot({ prisma, drawingId });
        if (!isCurrentJoin()) return;
        if (drawingNameSnapshot) socket.emit(DRAWING_NAME_EVENT, drawingNameSnapshot);
        // Somebody arriving mid-meeting should see the page the room is on,
        // not page one. Sent only to this socket; nobody else has to repaint.
        documentPages
          .snapshot(drawingId, socket.id)
          .then((pages) => socket.emit(DOCUMENT_PAGE_EVENT, pages))
          .catch((error) => {
            logger.error("Document page snapshot failed while joining a board", {
              socketId: socket.id,
              drawingId,
              error,
            });
          });
        followManager.invalidateAccess(socket.id);
        ack?.({ ok: true, presence: toPublicPresence(presence) });
      };
      const result = joinQueue.then(run, run);
      joinQueue = result.then(
        () => {
          pendingJoins -= 1;
        },
        () => {
          pendingJoins -= 1;
        },
      );
      return result;
    });

    socket.on("leave-room", async (data: unknown, ack?: RoomEventAck) => {
      joinRevision += 1;
      if (!allowJoin()) {
        leaveRoomFeedback.rateLimited();
        return;
      }
      const drawingId =
        data && typeof data === "object"
          ? parseDrawingId((data as Record<string, unknown>).drawingId)
          : null;
      if (!drawingId) {
        leaveRoomFeedback.invalid(ack);
        return;
      }
      if (drawingId && drawingBySocket.get(socket.id) === drawingId) {
        await removeFromDrawing(socket, "left-room");
      }
      leaveRoomFeedback.succeeded(ack);
    });

    socket.on("disconnect", async () => {
      joinRevision += 1;
      connectedSockets.delete(socket.id);
      credentialChecks.delete(socket.id);
      shareTokenBySocket.delete(socket.id);
      await removeFromDrawing(socket, "disconnected", false);
      principals.delete(socket.id);
    });
  });

  const recheckSockets = async (matches: (socketId: string, drawingId: string) => boolean) => {
    const candidates = Array.from(connectedSockets.values()).filter((socket) => {
      const drawingId = drawingBySocket.get(socket.id);
      return Boolean(drawingId && matches(socket.id, drawingId));
    });
    await Promise.all(
      candidates.map(async (socket) => {
        const drawingId = drawingBySocket.get(socket.id);
        if (!drawingId) return;
        followManager.invalidateAccess(socket.id);
        const decision = await getCapabilities(socket.id, drawingId);
        const { access } = decision;
        if (
          !canSocketView(socket.id, access) &&
          connectedSockets.get(socket.id) === socket &&
          drawingBySocket.get(socket.id) === drawingId
        ) {
          await removeFromDrawing(socket, "access-revoked");
          socket.emit("error", {
            message: "You do not have access to this drawing",
          });
          return;
        }
        if (
          connectedSockets.get(socket.id) === socket &&
          drawingBySocket.get(socket.id) === drawingId
        ) {
          await syncCommentRoom(socket, drawingId, decision.capabilities.viewComments);
        }
      }),
    );
  };

  const controller = createCollaborationAccessController({
    prisma,
    principals,
    recheckSockets,
    disconnectInactiveUserSockets: credentialGuard.disconnectInactiveUserSockets,
    disconnectApiKey,
    invalidateUserStatus: (userId) => activeAccounts.invalidate(userId),
  });

  registerApiKeySocketRevoker(disconnectApiKey);
  registerUserSocketRechecker(controller.recheckUserAccess);
  // Expiring link shares have no route invocation at expiry time. A periodic
  // server-side sweep bounds passive clients' access even if they send nothing.
  startNonOverlappingSocketAccessSweep(async () => {
    await recheckSockets(() => true);
    const staleByDrawing = new Map<string, BoardAgentRunAudience[]>();
    for (const stale of presences.pruneStaleAgents(Date.now() - BOARD_AGENT_PRESENCE_STALE_MS)) {
      const audiences = staleByDrawing.get(stale.drawingId) ?? [];
      audiences.push(stale.audience);
      staleByDrawing.set(stale.drawingId, audiences);
    }
    for (const [drawingId, audiences] of staleByDrawing) {
      emitBoardAgentPresenceSnapshots({ io, presences, drawingId, audiences });
    }
  }, accessRecheckIntervalMs);

  return controller;
};
