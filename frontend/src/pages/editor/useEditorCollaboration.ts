import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import type { UserIdentity } from "../../utils/identity";
import { buildRemoteSceneUpdate } from "./shared";
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
import { useDocumentPageSharing } from "./useDocumentPageSharing";
import { createViewportCapability } from "../../integrations/excalidraw/viewport";
import { bindInviteHere, type InviteHereStatus, type ViewportInvitation } from "./inviteHere";
import { bindSocketDrawingName } from "./drawingName";
import { createExcalidrawAdapter } from "../../integrations/excalidraw";
import type { CapabilityFailure } from "../../integrations/excalidraw/errors";
import type { ElementId, SceneFile } from "../../integrations/excalidraw/types";
export type { Peer } from "./socketCollaborators";

type UseEditorCollaborationInput = {
  drawingId?: string;
  me: UserIdentity;
  isReady: boolean;
  excalidrawAPI: MutableRefObject<any>;
  editorContainerRef: RefObject<HTMLDivElement>;
  lastSyncedFilesRef: MutableRefObject<Record<string, any>>;
  lastSyncedElementOrderSigRef: MutableRefObject<string>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  latestFilesRef: MutableRefObject<any>;
  computeElementOrderSig: (elements: readonly any[]) => string;
  recordElementVersion: (element: any) => void;
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
  me,
  isReady,
  excalidrawAPI,
  editorContainerRef,
  lastSyncedFilesRef,
  lastSyncedElementOrderSigRef,
  latestElementsRef,
  latestFilesRef,
  computeElementOrderSig,
  recordElementVersion,
  onAccessDenied,
  onDrawingNameChange,
}: UseEditorCollaborationInput) => {
  const [peers, setPeers] = useState<Peer[]>([]);
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
  const [viewportInvitation, setViewportInvitation] = useState<ViewportInvitation | null>(null);
  const [inviteHereStatus, setInviteHereStatus] = useState<InviteHereStatus | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const documentPageSharing = useDocumentPageSharing({ drawingId, socketRef });
  const inviteHereRef = useRef<ReturnType<typeof bindInviteHere> | null>(null);
  const lastCursorEmit = useRef<number>(0);
  const selectionPublisherRef = useRef<((selectedIds: readonly string[]) => void) | null>(null);
  const isSyncing = useRef(false);
  const pendingRemoteElementsRef = useRef<Map<string, any>>(new Map());
  const pendingRemoteFilesRef = useRef<Record<string, any>>({});
  const pendingRemoteElementOrderRef = useRef<string[] | null>(null);
  const remoteFlushScheduledRef = useRef(false);
  const remoteFlushRafIdRef = useRef<number | null>(null);
  const shareToken = getShareLinkToken();
  const adapter = useMemo(
    () =>
      createExcalidrawAdapter({
        api: () => excalidrawAPI.current,
        container: () => editorContainerRef.current,
        canEdit: () => true,
      }),
    [editorContainerRef, excalidrawAPI],
  );
  const reportCapabilityFailure = useCallback((failure: CapabilityFailure) => {
    console.warn("[Editor] Excalidraw capability failed:", failure);
    toast.error("Live collaboration could not update the editor.");
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
    if (import.meta.env.DEV) {
      (window as any).__EXCALIDASH_SOCKET_STATUS__ = {
        connected: socket.connected,
      };
      socket.on("connect", () => {
        (window as any).__EXCALIDASH_SOCKET_STATUS__ = { connected: true };
      });
      socket.on("disconnect", () => {
        (window as any).__EXCALIDASH_SOCKET_STATUS__ = { connected: false };
      });
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
      api: excalidrawAPI.current,
      onPeersChange: (nextPeers) => {
        chat.prunePeers(nextPeers);
        setPeers(nextPeers);
      },
      decorateName: chat.decorateName,
    });
    const remoteSelection = bindRemoteSelection({
      socket,
      drawingId,
      collaboration: adapter.collaboration,
      onCapabilityFailure: reportCapabilityFailure,
    });
    const workshopTimer = bindSocketWorkshopTimer({
      socket,
      drawingId,
      onChange: setWorkshopTimerSnapshot,
    });
    const drawingName = bindSocketDrawingName({
      socket,
      drawingId,
      onChange: onDrawingNameChange,
    });
    const sharedPages = documentPageSharing.bind(socket);
    const inviteHereController = bindInviteHere({
      socket,
      drawingId,
      viewport: createViewportCapability(() => excalidrawAPI.current),
      onInvitationChange: setViewportInvitation,
      onStatusChange: setInviteHereStatus,
    });
    inviteHereRef.current = inviteHereController;
    selectionPublisherRef.current = remoteSelection.publish;
    socket.on("error", (payload: any) => {
      const message = typeof payload?.message === "string" ? payload.message : null;
      console.warn("[Editor] Socket error:", payload);
      if (message === "You do not have access to this drawing") {
        onAccessDenied();
        return;
      }
      if (message) toast.error(message);
    });
    socket.on("room-event-error", (payload: any) => {
      const message = typeof payload?.error?.message === "string" ? payload.error.message : null;
      if (!message) return;
      console.warn("[Editor] Room event rejected:", payload);
      if (payload?.error?.code === "rate-limited") toast.info(message);
      else toast.error(message);
    });
    const unbindFollowMode = bindFollowMode({
      socket,
      drawingId,
      api: excalidrawAPI.current,
      container: editorContainerRef.current,
      onFollowersChange: setFollowers,
      onFollowInterrupted: (reason) => toast.info(getFollowInterruptionMessage(reason)),
    });
    const resetConnectionState = () => {
      unbindFollowMode.resetConnectionState();
      // The clearing message is volatile: dropped mid-sentence it never
      // arrives, and the same presence returns wearing what it used to say.
      cursorChat.pruneTo([]);
      collaborators.reset();
      remoteSelection.reset();
      workshopTimer.reset();
      sharedPages.reset();
      inviteHereController.reset();
      setFollowers([]);
      // A disconnect makes delivery acknowledgements unknowable. Forget the
      // confirmed file baseline so the next local comparison can resend bytes
      // instead of trusting markers from the previous connection.
      lastSyncedFilesRef.current = {};
      pendingRemoteElementsRef.current.clear();
      pendingRemoteFilesRef.current = {};
      pendingRemoteElementOrderRef.current = null;
      if (remoteFlushRafIdRef.current !== null) {
        cancelAnimationFrame(remoteFlushRafIdRef.current);
      }
      remoteFlushRafIdRef.current = null;
      remoteFlushScheduledRef.current = false;
    };
    const unbindSocketRoomLifecycle = bindSocketRoomLifecycle({
      socket,
      drawingId,
      shareToken,
      user: me,
      resetConnectionState,
      onJoined: (serverUser) => {
        collaborators.setSelfPresenceId(serverUser.presenceId);
        const selection = adapter.selection.read();
        if (!selection.ok) reportCapabilityFailure(selection);
        else remoteSelection.publish(selection.value.selectedIds);
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
        const followState = adapter.collaboration.readFollowState();
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
      const interaction = adapter.interaction.read();
      if (!interaction.ok) {
        reportCapabilityFailure(interaction);
        if (!remoteFlushScheduledRef.current) {
          remoteFlushScheduledRef.current = true;
          remoteFlushRafIdRef.current = requestAnimationFrame(flushRemoteUpdates);
        }
        return;
      }
      const protectedIds = new Set<ElementId>();
      for (const id of [
        interaction.value.editingTextElementId,
        interaction.value.resizingElementId,
        interaction.value.creatingElementId,
      ]) {
        if (id) protectedIds.add(id);
      }
      isSyncing.current = true;
      try {
        const pendingElements = Array.from(pendingRemoteElementsRef.current.values());
        pendingRemoteElementsRef.current.clear();
        const incomingFiles = pendingRemoteFilesRef.current || {};
        pendingRemoteFilesRef.current = {};
        const elementOrder = hasPendingOrder ? pendingOrderRaw : null;
        pendingRemoteElementOrderRef.current = null;
        const { sceneUpdate, mergedElements, nextFiles, shouldUpdateFiles } =
          buildRemoteSceneUpdate({
            localElements: excalidrawAPI.current.getSceneElementsIncludingDeleted(),
            pendingElements,
            elementOrder,
            lastSyncedFiles: lastSyncedFilesRef.current,
            incomingFiles,
            protectedIds,
          });
        let filesAdded = true;
        if (shouldUpdateFiles) {
          const added = adapter.files.add(Object.values(incomingFiles) as SceneFile[]);
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
        if (filesAdded && mergedElements) {
          if (elementOrder) {
            lastSyncedElementOrderSigRef.current = computeElementOrderSig(mergedElements);
          }
          pendingElements.forEach((el: any) => {
            recordElementVersion(el);
          });
          if (sceneUpdate && "elements" in sceneUpdate) {
            excalidrawAPI.current.updateScene({
              elements: sceneUpdate.elements,
              captureUpdate: sceneUpdate.captureUpdate,
            });
          }
          latestElementsRef.current = mergedElements;
        }
        if (shouldUpdateFiles && filesAdded) {
          latestFilesRef.current = nextFiles;
          lastSyncedFilesRef.current = nextFiles;
        }
      } finally {
        isSyncing.current = false;
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
      toast.info("Drawing storage changed on the server. Reloading the editor.");
      window.location.reload();
    });
    const handleActivity = (isActive: boolean) => {
      socket.emit("user-activity", { drawingId, isActive });
    };
    const onFocus = () => handleActivity(true);
    const onBlur = () => handleActivity(false);
    const onMouseEnter = () => handleActivity(true);
    const onMouseLeave = () => handleActivity(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mouseenter", onMouseEnter);
    document.addEventListener("mouseleave", onMouseLeave);
    const container = editorContainerRef.current;
    const unbindWheelZoom = bindCanvasWheelZoom(container);
    return () => {
      unbindWheelZoom();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mouseenter", onMouseEnter);
      document.removeEventListener("mouseleave", onMouseLeave);
      socket.off("error");
      socket.off("room-event-error");
      socket.off("element-update");
      socket.off("drawing-server-update");
      unbindSocketRoomLifecycle();
      unbindFollowMode();
      cursorChat.dispose();
      cursorChatRef.current = null;
      setCursorChatDraft(null);
      collaborators.dispose();
      remoteSelection.dispose();
      workshopTimer.dispose();
      drawingName.dispose();
      sharedPages.dispose();
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
    computeElementOrderSig,
    recordElementVersion,
    onAccessDenied,
    onDrawingNameChange,
    shareToken,
    adapter,
    reportCapabilityFailure,
  ]);
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

  return {
    peers,
    cursorChatRef,
    cursorChatDraft,
    selfIdentity,
    followers,
    workshopTimer: { snapshot: workshopTimerSnapshot, sendCommand: sendWorkshopTimerCommand },
    documentPages: documentPageSharing.controller,
    socketRef,
    isSyncing,
    onPointerUpdate,
    onSelectionChange,
    inviteHere,
  };
};
