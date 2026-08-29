import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { io, type Socket } from "socket.io-client";
import { notify } from "../../notifications";
import type { UserIdentity } from "../../utils/identity";
import { buildRemoteSceneUpdate, heldElementIds } from "./shared";
import { bindFollowMode, getFollowInterruptionMessage, type Follower } from "./followMode";
import { bindCanvasWheelZoom } from "./wheelZoom";
import { bindSocketRoomLifecycle } from "./socketRoomLifecycle";
import { getShareLinkToken } from "../../api";
import { bindSocketCollaborators } from "./socketCollaborators";
import type { Peer } from "./socketCollaborators";
import { bindRemoteSelection } from "./remoteSelection";
import { startCursorChat, type CursorChatController } from "./cursorChat";
import {
  bindSocketWorkshopTimer,
  createIdleWorkshopTimerSnapshot,
  WORKSHOP_TIMER_COMMAND_EVENT,
  type WorkshopTimerAction,
} from "./workshopTimer";
import {
  bindPresenterMode,
  createIdlePresenterSnapshot,
  type PresenterNotes,
} from "./presenterMode";
import { bindVotingMode } from "./votingMode";
import type { VotingSnapshot } from "./votingMode";
import type { FrameSummary } from "./frameNavigator";
import { useDocumentPageSharing } from "./useDocumentPageSharing";
import { useDocumentEditLocks } from "./useDocumentEditLocks";
import type { DocumentAssetReplacement } from "./documentAssetReplacement";
import { bindInviteHere, type InviteHereStatus, type ViewportInvitation } from "./inviteHere";
import { bindSocketDrawingName } from "./drawingName";
import type { CapabilityFailure } from "../../integrations/excalidraw/errors";
import { sealSceneDocument } from "../../integrations/excalidraw/adapter";
import type { SceneFile } from "../../integrations/excalidraw/types";
import type {
  CollaborationCapability,
  FileCapability,
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
} from "../../integrations/excalidraw/capabilities";
import { log } from "../../logging";
import { deriveStickyFontState } from "../../sticky/stickyDerivedState";
export type { Peer } from "./socketCollaborators";

/**
 * What the connection status chrome (NIL-591) shows.
 *
 * "connected" is deliberately not `socket.connected` -- a transport can be up
 * with the room not yet (re)joined, which is the exact window a stale local
 * timer state (NIL-591's own motivating bug: local state fell to idle, then
 * the server's rejoin reply said "finished") lives in. This mirrors
 * `bindSocketRoomLifecycle`'s own distinction: "connected" only once
 * `onJoined` fires, "reconnecting" the moment `resetConnectionState` runs
 * (on every disconnect, and again at the start of each join attempt).
 * "offline" is `navigator.onLine` going false -- a genuinely different fact
 * from "reconnecting" (no network at all, vs. a network that is trying).
 */
export type ConnectionStatus = "connected" | "reconnecting" | "offline";

type UseEditorCollaborationInput = {
  drawingId?: string;
  collaboration: CollaborationCapability;
  files: FileCapability;
  interaction: InteractionCapability;
  me: UserIdentity;
  isReady: boolean;
  excalidrawAPI: MutableRefObject<any>;
  editorContainerRef: RefObject<HTMLDivElement>;
  lastSyncedFilesRef: MutableRefObject<Record<string, any>>;
  lastSyncedElementOrderSigRef: MutableRefObject<string>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  latestFilesRef: MutableRefObject<any>;
  currentDrawingVersionRef: MutableRefObject<number | null>;
  computeElementOrderSig: (elements: readonly any[]) => string;
  recordElementVersion: (element: any) => void;
  scene: SceneCapability;
  selection: SelectionCapability;
  viewport: ViewportCapability;
  onAccessDenied: () => void;
  onDrawingNameChange: (name: string) => void;
};

const getSocketUrl = () =>
  import.meta.env.VITE_API_URL === "/api"
    ? window.location.origin
    : import.meta.env.VITE_API_URL ||
      import.meta.env.VITE_DEV_BACKEND_URL ||
      "http://localhost:8000";

export const useEditorCollaboration = ({
  drawingId,
  collaboration,
  files,
  interaction,
  me,
  isReady,
  excalidrawAPI,
  editorContainerRef,
  lastSyncedFilesRef,
  lastSyncedElementOrderSigRef,
  latestElementsRef,
  latestFilesRef,
  currentDrawingVersionRef,
  computeElementOrderSig,
  recordElementVersion,
  scene,
  selection,
  viewport,
  onAccessDenied,
  onDrawingNameChange,
}: UseEditorCollaborationInput) => {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "reconnecting",
  );
  // Ref because it outlives renders; the draft is state because React draws it.
  const cursorChatRef = useRef<CursorChatController | null>(null);
  const [cursorChatDraft, setCursorChatDraft] = useState<string | null>(null);
  // What the server decided this connection is called. For an account it agrees
  // with the local identity; for a share-link visitor the server picks the name,
  // and showing them a different one than everyone else sees is a small lie.
  const [selfIdentity, setSelfIdentity] = useState<UserIdentity | null>(null);
  const [followers, setFollowers] = useState<Follower[]>([]);
  const [workshopTimerSnapshot, setWorkshopTimerSnapshot] = useState(() =>
    createIdleWorkshopTimerSnapshot(drawingId || ""),
  );
  const [presenterSnapshot, setPresenterSnapshot] = useState(() =>
    createIdlePresenterSnapshot(drawingId || ""),
  );
  const [presenterNotes, setPresenterNotes] = useState<PresenterNotes>({ frameId: null, text: "" });
  const [isFollowingPresenter, setIsFollowingPresenter] = useState(true);
  const [votingSnapshot, setVotingSnapshot] = useState<VotingSnapshot>({
    drawingId: drawingId || "",
    status: "idle",
    roundId: null,
    prompt: null,
    options: null,
    maxSelections: null,
    tally: null,
    participantCount: null,
  });
  const [isVotingComposing, setIsVotingComposing] = useState(false);
  const presenterModeRef = useRef<ReturnType<typeof bindPresenterMode> | null>(null);
  const votingModeRef = useRef<ReturnType<typeof bindVotingMode> | null>(null);
  const [viewportInvitation, setViewportInvitation] = useState<ViewportInvitation | null>(null);
  const [inviteHereStatus, setInviteHereStatus] = useState<InviteHereStatus | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const roomJoinedRef = useRef(false);
  const documentPageSharing = useDocumentPageSharing({ drawingId, socketRef });
  const { controller: documentEdits, bind: bindDocumentEditLocks } = useDocumentEditLocks({
    drawingId,
    socketRef,
  });
  const inviteHereRef = useRef<ReturnType<typeof bindInviteHere> | null>(null);
  const lastCursorEmit = useRef<number>(0);
  const selectionPublisherRef = useRef<((selectedIds: readonly string[]) => void) | null>(null);
  const isSyncing = useRef(false);
  // What `handleCanvasChange` (useEditorCanvasHandlers.ts) waits for to know
  // the guard above is safe to release -- see the reset site below (NIL-685)
  // for why a fixed delay cannot answer that question.
  const pendingSyncFingerprintRef = useRef<Map<string, string> | null>(null);
  const pendingRemoteElementsRef = useRef<Map<string, any>>(new Map());
  const pendingRemoteFilesRef = useRef<Record<string, any>>({});
  const pendingRemoteElementOrderRef = useRef<string[] | null>(null);
  const remoteFlushScheduledRef = useRef(false);
  const remoteFlushRafIdRef = useRef<number | null>(null);
  const shareToken = getShareLinkToken();
  const reportCapabilityFailure = useCallback((failure: CapabilityFailure) => {
    log.warn("[Editor] Excalidraw capability failed", { failure });
    notify("error", "Live collaboration could not update the editor.");
  }, []);
  useEffect(() => {
    if (!drawingId || !isReady) return;
    setSelfIdentity(null);
    const socket = io(getSocketUrl(), {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
    });
    socketRef.current = socket;
    roomJoinedRef.current = false;
    // Not reset here on every effect (re-)run: `resetConnectionState` below
    // already covers a fresh socket correctly -- it fires the moment this
    // socket actually connects (or immediately, if it's already connected --
    // see `bindSocketRoomLifecycle`'s `if (socket.connected)` check), which
    // is a real event, unlike this effect potentially re-running for
    // unrelated reasons (e.g. a parent re-render producing a new callback
    // reference). Setting it unconditionally here doubled as a spurious
    // "reconnecting" flash injected between two renders that were still the
    // same live, joined connection -- caught by this file's own test suite
    // once a state-setting act() (unrelated to the socket) triggered a
    // second effect pass.
    if (import.meta.env.DEV) {
      const socketTestStatus = { connected: socket.connected } as {
        connected: boolean;
        roomJoined: boolean;
        dropTransport: () => void;
      };
      Object.defineProperties(socketTestStatus, {
        roomJoined: {
          enumerable: false,
          value: roomJoinedRef.current,
          writable: true,
        },
        dropTransport: {
          enumerable: false,
          value: () => socket.io.engine?.close(),
        },
      });
      const updateSocketTestStatus = () => {
        socketTestStatus.connected = socket.connected;
        socketTestStatus.roomJoined = roomJoinedRef.current;
      };
      (window as any).__EXCALIDASH_SOCKET_STATUS__ = socketTestStatus;
      updateSocketTestStatus();
      socket.on("connect", updateSocketTestStatus);
      socket.on("disconnect", updateSocketTestStatus);
    }
    // Bound before the collaborators (they read it), referred to after (a
    // message has to refresh the names).
    let collaborators: ReturnType<typeof bindSocketCollaborators> | null = null;
    const chat = startCursorChat({
      socket,
      drawingId,
      onRemoteChange: () => collaborators?.refresh(),
      onDraftChange: setCursorChatDraft,
    });
    const cursorChat = chat.controller;
    cursorChatRef.current = cursorChat;

    collaborators = bindSocketCollaborators({
      socket,
      collaboration,
      onPeersChange: (nextPeers) => {
        chat.prunePeers(nextPeers);
        setPeers(nextPeers);
      },
      decorateName: chat.decorateName,
    });
    const remoteSelection = bindRemoteSelection({
      socket,
      drawingId,
      collaboration,
      onCapabilityFailure: reportCapabilityFailure,
    });
    const workshopTimer = bindSocketWorkshopTimer({
      socket,
      drawingId,
      onChange: setWorkshopTimerSnapshot,
    });
    const presenterMode = bindPresenterMode({
      socket,
      drawingId,
      viewport,
      onStateChange: setPresenterSnapshot,
      onNotesChange: setPresenterNotes,
    });
    presenterModeRef.current = presenterMode;
    const votingMode = bindVotingMode({
      socket,
      drawingId,
      onStateChange: (snapshot) => {
        setVotingSnapshot(snapshot);
        if (snapshot.status !== "idle") setIsVotingComposing(false);
      },
    });
    votingModeRef.current = votingMode;
    const drawingName = bindSocketDrawingName({
      socket,
      drawingId,
      onChange: onDrawingNameChange,
    });
    const sharedPages = documentPageSharing.bind(socket);
    const sharedDocumentEdits = bindDocumentEditLocks(socket);
    selectionPublisherRef.current = remoteSelection.publish;
    socket.on("error", (payload: any) => {
      const message = typeof payload?.message === "string" ? payload.message : null;
      log.warn("[Editor] Socket error", { payload });
      if (message === "You do not have access to this drawing") {
        onAccessDenied();
        return;
      }
      if (message) notify("error", message);
    });
    socket.on("room-event-error", (payload: any) => {
      const message = typeof payload?.error?.message === "string" ? payload.error.message : null;
      if (!message) return;
      log.warn("[Editor] Room event rejected", { payload });
      if (payload?.error?.code === "rate-limited") {
        // A cursor update is volatile by design: once the server drops one,
        // the next accepted position supersedes it. Keep the protection in
        // the log, but do not turn an internal traffic budget into a user
        // action. Other rate-limited commands really were refused and remain
        // visible below.
        if (payload?.event !== "cursor-move") notify("info", message);
        return;
      }
      notify("error", message);
    });
    const unbindFollowMode = bindFollowMode({
      socket,
      drawingId,
      collaboration,
      viewport,
      container: editorContainerRef.current,
      onFollowersChange: setFollowers,
      onFollowInterrupted: (reason) => notify("info", getFollowInterruptionMessage(reason)),
    });
    const inviteHereController = bindInviteHere({
      socket,
      drawingId,
      viewport,
      onInvitationChange: setViewportInvitation,
      onStatusChange: setInviteHereStatus,
      onAlreadyThere: () => notify("info", "You're already looking at this area."),
      onFollow: unbindFollowMode.follow,
    });
    inviteHereRef.current = inviteHereController;
    const resetConnectionState = () => {
      roomJoinedRef.current = false;
      setConnectionStatus(
        typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "reconnecting",
      );
      if (import.meta.env.DEV) {
        const status = (window as any).__EXCALIDASH_SOCKET_STATUS__;
        if (status) status.roomJoined = false;
      }
      unbindFollowMode.resetConnectionState();
      // The clearing message is volatile: dropped mid-sentence it never
      // arrives, and the same presence returns wearing what it used to say.
      cursorChat.pruneTo([]);
      collaborators.reset();
      remoteSelection.reset();
      workshopTimer.reset();
      presenterMode.reset();
      votingMode.reset();
      setIsVotingComposing(false);
      sharedPages.reset();
      sharedDocumentEdits.reset();
      inviteHereController.reset();
      setFollowers([]);
      // Keep the acknowledged file baseline. Unacknowledged attempts never
      // enter it and remain in the delivery queue, while clearing confirmed
      // files here turns every historical image into reconnect work and can
      // bury the first genuinely fresh file behind a full-board replay.
      pendingRemoteElementsRef.current.clear();
      pendingRemoteFilesRef.current = {};
      pendingRemoteElementOrderRef.current = null;
      if (remoteFlushRafIdRef.current !== null) {
        cancelAnimationFrame(remoteFlushRafIdRef.current);
      }
      remoteFlushRafIdRef.current = null;
      remoteFlushScheduledRef.current = false;
      pendingSyncFingerprintRef.current = null;
      isSyncing.current = false;
    };
    const unbindSocketRoomLifecycle = bindSocketRoomLifecycle({
      socket,
      drawingId,
      shareToken,
      user: me,
      resetConnectionState,
      onJoined: (serverUser) => {
        roomJoinedRef.current = true;
        setConnectionStatus("connected");
        documentPageSharing.confirmRoomJoined(socket);
        if (import.meta.env.DEV) {
          const status = (window as any).__EXCALIDASH_SOCKET_STATUS__;
          if (status) status.roomJoined = true;
        }
        collaborators.setSelfPresenceId(serverUser.presenceId);
        const selected = selection.read();
        if (!selected.ok) reportCapabilityFailure(selected);
        else remoteSelection.publish(selected.value.selectedIds);
        if (serverUser.name && serverUser.color) {
          setSelfIdentity({
            id: me.id,
            name: serverUser.name,
            initials: serverUser.initials || me.initials,
            color: serverUser.color,
          });
        }
      },
      getFollowTargetPresenceId: () => {
        const followState = collaboration.readFollowState();
        if (!followState.ok) {
          reportCapabilityFailure(followState);
          return null;
        }
        return followState.value.followingSocketId;
      },
    });
    const hasNonEmptyArray = (value: unknown): value is any[] =>
      Array.isArray(value) && value.length > 0;
    const flushRemoteUpdates = () => {
      remoteFlushScheduledRef.current = false;
      remoteFlushRafIdRef.current = null;
      if (!excalidrawAPI.current) return;
      const hasPendingElements = pendingRemoteElementsRef.current.size > 0;
      const hasPendingFiles = Object.keys(pendingRemoteFilesRef.current || {}).length > 0;
      const pendingOrderRaw = pendingRemoteElementOrderRef.current;
      const hasPendingOrder = hasNonEmptyArray(pendingOrderRaw);
      if (!hasPendingElements && !hasPendingFiles && !hasPendingOrder) return;
      const interactionState = interaction.read();
      if (!interactionState.ok) {
        reportCapabilityFailure(interactionState);
        if (!remoteFlushScheduledRef.current) {
          remoteFlushScheduledRef.current = true;
          remoteFlushRafIdRef.current = requestAnimationFrame(flushRemoteUpdates);
        }
        return;
      }
      const protectedIds = heldElementIds(interactionState.value, latestElementsRef.current);
      isSyncing.current = true;
      let appliedSceneMutation = false;
      let finalElementsById: Map<string, any> | null = null;
      // Declared here, not `const` inside `try`, so the `finally` block below
      // (which builds the fingerprint from it) can still see it -- a bare
      // `const` there is out of scope in `finally` and throws a
      // `ReferenceError` that silently aborts this rAF callback, leaving
      // `isSyncing` stuck at `true` forever with no fingerprint to release it
      // (caught directly, NIL-685: this exact bug shipped in an earlier
      // version of this fix and reproduced as the guard never releasing).
      let pendingElements: any[] = [];
      try {
        pendingElements = Array.from(pendingRemoteElementsRef.current.values());
        pendingRemoteElementsRef.current.clear();
        const incomingFiles = pendingRemoteFilesRef.current || {};
        pendingRemoteFilesRef.current = {};
        const elementOrder = hasPendingOrder ? pendingOrderRaw : null;
        pendingRemoteElementOrderRef.current = null;
        const { sceneUpdate, mergedElements, nextFiles, shouldUpdateFiles } =
          buildRemoteSceneUpdate({
            localElements: latestElementsRef.current,
            pendingElements,
            elementOrder,
            lastSyncedFiles: lastSyncedFilesRef.current,
            incomingFiles,
            protectedIds,
          });
        let filesAdded = true;
        if (shouldUpdateFiles) {
          const added = files.add(Object.values(incomingFiles) as SceneFile[]);
          if (!added.ok) {
            reportCapabilityFailure(added);
            pendingRemoteFilesRef.current = {
              ...incomingFiles,
              ...pendingRemoteFilesRef.current,
            };
            for (const element of pendingElements) {
              if (!pendingRemoteElementsRef.current.has(element.id)) {
                pendingRemoteElementsRef.current.set(element.id, element);
              }
            }
            if (elementOrder && pendingRemoteElementOrderRef.current === null) {
              pendingRemoteElementOrderRef.current = elementOrder;
            }
            filesAdded = false;
          }
        }
        const renderedElements = mergedElements
          ? deriveStickyFontState(mergedElements, protectedIds)
          : mergedElements;
        let sceneApplied = true;
        if (filesAdded && mergedElements && sceneUpdate && "elements" in sceneUpdate) {
          const applied = scene.apply(
            [
              {
                kind: "replaceDocument",
                document: sealSceneDocument({
                  elements: renderedElements ?? sceneUpdate.elements,
                  appState: {},
                  files: {},
                }),
              },
            ],
            { capture: "never" },
          );
          if (!applied.ok) {
            reportCapabilityFailure(applied);
            if (shouldUpdateFiles) {
              pendingRemoteFilesRef.current = {
                ...incomingFiles,
                ...pendingRemoteFilesRef.current,
              };
            }
            for (const element of pendingElements) {
              if (!pendingRemoteElementsRef.current.has(element.id)) {
                pendingRemoteElementsRef.current.set(element.id, element);
              }
            }
            if (elementOrder && pendingRemoteElementOrderRef.current === null) {
              pendingRemoteElementOrderRef.current = elementOrder;
            }
            sceneApplied = false;
          } else {
            appliedSceneMutation = true;
          }
        }
        if (filesAdded && sceneApplied && mergedElements) {
          if (elementOrder) {
            lastSyncedElementOrderSigRef.current = computeElementOrderSig(mergedElements);
          }
          // Record the version/signature of the element AS APPLIED
          // (post-derivation), not the raw incoming one. `hasElementChanged`
          // (useEditorElementTracking.ts, consulted by broadcastChanges) also
          // compares a content signature, and that signature reflects
          // whatever Excalidraw's own onChange reports next -- the locally
          // re-derived value (e.g. a Sticky note's fitted font size), not the
          // raw wire payload. Recording the raw element left that signature
          // permanently mismatched against the derived one, so the correctly
          // -derived value looked "changed" on every subsequent onChange and
          // got broadcast right back out -- the deterministic half of
          // NIL-685's echo loop (the timing gap below is the other half).
          const finalElements = renderedElements ?? mergedElements;
          finalElementsById = new Map(finalElements.map((el: any) => [el.id, el]));
          pendingElements.forEach((el: any) => {
            recordElementVersion(finalElementsById!.get(el.id) ?? el);
          });
          latestElementsRef.current = finalElements;
        }
        if (shouldUpdateFiles && filesAdded && sceneApplied) {
          latestFilesRef.current = nextFiles;
          lastSyncedFilesRef.current = nextFiles;
        }
      } finally {
        if (appliedSceneMutation) {
          // `scene.apply()` returning does not mean Excalidraw's own
          // `onChange` for that applied update has fired yet -- it goes
          // through `updateScene()` -> `setState()`, committed on a later
          // render, not synchronously inside `apply()`. Resetting the guard
          // here, synchronously, closed the window before that `onChange`
          // arrived: `handleCanvasChange` (useEditorCanvasHandlers.ts) would
          // then see `isSyncing.current === false` for a change this client
          // did not make, treat it as a local edit, and re-broadcast it
          // (confirmed directly, NIL-685: `deriveStickyFontState` computed
          // the correct value every cycle, `scene.apply` reported `ok:true`
          // every cycle, and `handleCanvasChange` fired with
          // `isSyncing:false` immediately after each one).
          //
          // A fixed delay (N animation frames) cannot fix this correctly: too
          // short and the race reopens under load (this is what shipped as a
          // partial fix during the 0.14 investigation and still failed
          // ~20-25% of runs); too long and a genuine local edit typed in that
          // window is silently dropped. Waiting for a *fact* instead of a
          // *guess* removes the choice: record the version/versionNonce this
          // client expects to see echoed back, per updated element, and let
          // `handleCanvasChange` release the guard itself the moment an
          // `onChange` reports exactly that state -- however many frames that
          // takes. The 2s `setTimeout` below is only a backstop against
          // Excalidraw never firing that `onChange` at all (e.g. a merge that
          // produces no net change), not the normal exit.
          const fingerprint = new Map<string, string>();
          for (const el of pendingElements) {
            const applied = finalElementsById?.get(el.id) ?? el;
            fingerprint.set(el.id, `${applied?.version ?? 0}:${applied?.versionNonce ?? 0}`);
          }
          pendingSyncFingerprintRef.current = fingerprint;
          window.setTimeout(() => {
            if (pendingSyncFingerprintRef.current === fingerprint) {
              pendingSyncFingerprintRef.current = null;
              isSyncing.current = false;
              log.warn(
                "[Editor] isSyncing guard force-cleared after timeout -- expected onChange never arrived (NIL-685 fallback)",
                {},
              );
            }
          }, 2000);
        } else {
          isSyncing.current = false;
        }
      }
      const moreElements = pendingRemoteElementsRef.current.size > 0;
      const moreFiles = Object.keys(pendingRemoteFilesRef.current || {}).length > 0;
      const moreOrder = hasNonEmptyArray(pendingRemoteElementOrderRef.current);
      if (moreElements || moreFiles || moreOrder) {
        if (!remoteFlushScheduledRef.current) {
          remoteFlushScheduledRef.current = true;
          remoteFlushRafIdRef.current = requestAnimationFrame(flushRemoteUpdates);
        }
      }
    };
    const scheduleRemoteFlush = () => {
      if (remoteFlushScheduledRef.current) return;
      remoteFlushScheduledRef.current = true;
      remoteFlushRafIdRef.current = requestAnimationFrame(flushRemoteUpdates);
    };
    socket.on(
      "element-update",
      ({
        elements,
        files,
        elementOrder,
      }: {
        elements: any[];
        files?: Record<string, any>;
        elementOrder?: string[];
      }) => {
        if (Array.isArray(elements)) {
          for (const el of elements) {
            const id = el?.id;
            if (typeof id === "string" && id.length > 0) {
              pendingRemoteElementsRef.current.set(id, el);
            }
          }
        }
        if (files && typeof files === "object") {
          pendingRemoteFilesRef.current = {
            ...pendingRemoteFilesRef.current,
            ...files,
          };
        }
        if (Array.isArray(elementOrder) && elementOrder.length > 0) {
          pendingRemoteElementOrderRef.current = elementOrder;
        }
        scheduleRemoteFlush();
      },
    );
    socket.on("drawing-server-update", (payload: { drawingId?: string }) => {
      if (!payload?.drawingId || payload.drawingId !== drawingId) return;
      notify("info", "Drawing storage changed on the server. Reloading the editor.");
      window.location.reload();
    });
    socket.on("document-asset-replaced", (payload: DocumentAssetReplacement) => {
      if (payload?.drawingId !== drawingId) return;
      if (Number.isInteger(payload.drawingVersion)) {
        currentDrawingVersionRef.current = Math.max(
          currentDrawingVersionRef.current ?? 0,
          payload.drawingVersion,
        );
      }
      if (!Array.isArray(payload.elements) || payload.elements.length === 0) {
        notify("error", "A Markdown update could not be applied. Reload the board.");
        return;
      }
      for (const element of payload.elements) {
        if (typeof element?.id === "string" && element.id) {
          pendingRemoteElementsRef.current.set(element.id, element);
        }
      }
      scheduleRemoteFlush();
    });
    const handleActivity = (isActive: boolean) => {
      socket.emit("user-activity", { drawingId, isActive });
    };
    const onFocus = () => handleActivity(true);
    const onBlur = () => handleActivity(false);
    const onMouseEnter = () => handleActivity(true);
    const onMouseLeave = () => handleActivity(false);
    // `navigator.onLine` going false is the browser reporting no network at
    // all -- a stronger, more specific fact than "the socket hasn't rejoined
    // yet" and worth its own status rather than folding into "reconnecting".
    // Regaining network does not itself mean the room is rejoined: fall back
    // to "reconnecting" and let the socket's own `connect`/`onJoined` events
    // (above) promote it to "connected" once that is actually true again.
    const onNetworkOffline = () => setConnectionStatus("offline");
    const onNetworkOnline = () => {
      // A stale/joined-elsewhere transport can outlive a brief network blip
      // without ever actually disconnecting, so this must not stomp a
      // genuinely current "connected" with a spurious "reconnecting".
      if (!roomJoinedRef.current) setConnectionStatus("reconnecting");
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mouseenter", onMouseEnter);
    document.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("offline", onNetworkOffline);
    window.addEventListener("online", onNetworkOnline);
    const container = editorContainerRef.current;
    const unbindWheelZoom = bindCanvasWheelZoom(container);
    return () => {
      unbindWheelZoom();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mouseenter", onMouseEnter);
      document.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("offline", onNetworkOffline);
      window.removeEventListener("online", onNetworkOnline);
      socket.off("error");
      socket.off("room-event-error");
      socket.off("element-update");
      socket.off("drawing-server-update");
      socket.off("document-asset-replaced");
      unbindSocketRoomLifecycle();
      unbindFollowMode();
      cursorChat.dispose();
      cursorChatRef.current = null;
      setCursorChatDraft(null);
      collaborators.dispose();
      remoteSelection.dispose();
      workshopTimer.dispose();
      presenterMode.dispose();
      if (presenterModeRef.current === presenterMode) presenterModeRef.current = null;
      votingMode.dispose();
      if (votingModeRef.current === votingMode) votingModeRef.current = null;
      drawingName.dispose();
      sharedPages.dispose();
      sharedDocumentEdits.dispose();
      inviteHereController.dispose();
      if (inviteHereRef.current === inviteHereController) inviteHereRef.current = null;
      if (selectionPublisherRef.current === remoteSelection.publish) {
        selectionPublisherRef.current = null;
      }
      socket.disconnect();
      if (remoteFlushRafIdRef.current !== null) {
        cancelAnimationFrame(remoteFlushRafIdRef.current);
        remoteFlushRafIdRef.current = null;
      }
      remoteFlushScheduledRef.current = false;
      pendingRemoteElementsRef.current.clear();
      pendingRemoteFilesRef.current = {};
      pendingRemoteElementOrderRef.current = null;
    };
  }, [
    drawingId,
    me,
    isReady,
    excalidrawAPI,
    editorContainerRef,
    lastSyncedFilesRef,
    lastSyncedElementOrderSigRef,
    latestElementsRef,
    latestFilesRef,
    currentDrawingVersionRef,
    bindDocumentEditLocks,
    computeElementOrderSig,
    recordElementVersion,
    onAccessDenied,
    onDrawingNameChange,
    shareToken,
    collaboration,
    files,
    interaction,
    scene,
    selection,
    viewport,
    reportCapabilityFailure,
  ]);
  // Not `CollaborationCapability.onLocalPointerBroadcast()` in
  // capabilities.ts/collaboration.ts -- that method always reports unsupported today. This
  // is the live pointer stream, wired through Editor.tsx as a direct prop, not through that
  // capability method. This local name stays `onPointerUpdate` because it is what the
  // Excalidraw `onPointerUpdate` prop it implements is called.
  const onPointerUpdate = useCallback(
    (payload: any) => {
      const now = Date.now();
      if (now - lastCursorEmit.current > 50 && socketRef.current) {
        socketRef.current.emit("cursor-move", {
          pointer: payload.pointer,
          button: payload.button,
          drawingId,
        });
        lastCursorEmit.current = now;
      }
    },
    [drawingId],
  );
  const onSelectionChange = useCallback((appState: any) => {
    const selectedIds = Object.entries(appState?.selectedElementIds || {})
      .filter(([id, selected]) => selected === true && id.length > 0)
      .map(([id]) => id);
    selectionPublisherRef.current?.(selectedIds);
  }, []);
  const sendWorkshopTimerCommand = useCallback(
    (action: WorkshopTimerAction, durationMs?: number) => {
      if (!drawingId || !socketRef.current) return;
      socketRef.current.emit(WORKSHOP_TIMER_COMMAND_EVENT, { drawingId, action, durationMs });
    },
    [drawingId],
  );
  const inviteHere = {
    invitation: viewportInvitation,
    status: inviteHereStatus,
    invite: () => inviteHereRef.current?.invite(),
    accept: () => inviteHereRef.current?.accept(),
    decline: () => inviteHereRef.current?.decline(),
  };
  const notReady = { ok: false as const, error: { code: "not-ready", message: "Not connected" } };
  const presenting = {
    snapshot: presenterSnapshot,
    isSelf:
      presenterSnapshot.status === "presenting" &&
      presenterSnapshot.presenterPresenceId === socketRef.current?.id,
    notes: presenterNotes,
    isFollowing: isFollowingPresenter,
    start: () => presenterModeRef.current?.start() ?? Promise.resolve(notReady),
    stop: () => presenterModeRef.current?.stop() ?? Promise.resolve(notReady),
    takeover: () => presenterModeRef.current?.takeover() ?? Promise.resolve(notReady),
    jumpToFrame: (frame: FrameSummary) =>
      presenterModeRef.current?.jumpToFrame(frame.id, frame.bounds),
    setNotes: (text: string) => presenterModeRef.current?.setNotes(presenterSnapshot.frameId, text),
    setFollowing: (following: boolean) => {
      presenterModeRef.current?.setFollowing(following);
      setIsFollowingPresenter(following);
    },
  };
  const voting = {
    snapshot: votingSnapshot,
    isComposing: isVotingComposing,
    openCompose: () => setIsVotingComposing(true),
    closeCompose: () => setIsVotingComposing(false),
    open: (prompt: string, options: readonly string[], maxSelections: number) =>
      votingModeRef.current?.open(prompt, options, maxSelections) ?? Promise.resolve(notReady),
    reveal: () => votingModeRef.current?.reveal() ?? Promise.resolve(notReady),
    close: () => votingModeRef.current?.close() ?? Promise.resolve(notReady),
    cast: (roundId: string, optionIds: readonly string[]) =>
      votingModeRef.current?.cast(roundId, optionIds) ?? Promise.resolve(notReady),
  };

  return {
    peers,
    connectionStatus,
    cursorChatRef,
    cursorChatDraft,
    selfIdentity,
    followers,
    workshopTimer: { snapshot: workshopTimerSnapshot, sendCommand: sendWorkshopTimerCommand },
    documentPages: documentPageSharing.controller,
    documentEdits,
    socketRef,
    roomJoinedRef,
    isSyncing,
    pendingSyncFingerprintRef,
    onPointerUpdate,
    onSelectionChange,
    inviteHere,
    presenting,
    voting,
  };
};
