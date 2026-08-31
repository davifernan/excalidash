import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { createExcalidrawAdapter } from "../integrations/excalidraw";
import { openSceneDocument } from "../integrations/excalidraw/adapter";
import { useExcalidrawToastBridge } from "../integrations/excalidraw/toastBridge";
import { useCursorChatKey } from "./editor/useCursorChatKey";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { getInitialLangCode } from "../components/LanguageSelector";
import type { UserIdentity } from "../utils/identity";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useEditorChrome } from "./editor/useEditorChrome";
import { useEditorIdentity } from "./editor/useEditorIdentity";
import { EditorDialogs } from "./editor/EditorDialogs";
import { EditorView } from "./editor/EditorView";
import { useLibraryImportFromUrl } from "./editor/useLibraryImportFromUrl";
import { useEditorSnapshotGuards } from "./editor/useEditorSnapshotGuards";
import { useEditorSceneLoader } from "./editor/useEditorSceneLoader";
import { useEditorCollaboration } from "./editor/useEditorCollaboration";
import { useEditorPersistence } from "./editor/useEditorPersistence";
import { useEditorCanvasHandlers } from "./editor/useEditorCanvasHandlers";
import { useGridModePreference } from "./editor/useGridModePreference";
import { useStickyNotesFeature } from "../sticky";
import { canonicalizeStickyFontState } from "../sticky/stickyDerivedState";
import { useMindMapFeature } from "../mindMap";
import { mindMapLayoutRunCount } from "../mindMap/mindMapScene";
import { ambientTreeDragApplyCount, useAmbientTreeDrag } from "../ambientTree/useAmbientTreeDrag";
import { useEditorCommands } from "./editor/useEditorCommands";
import {
  captureElementVersionInfo,
  useEditorElementTracking,
} from "./editor/useEditorElementTracking";
import { useEditorBroadcast, type DeliveryState } from "./editor/useEditorBroadcast";
import { useEditorAddFilesBridge } from "./editor/useEditorAddFilesBridge";
import { useEditorFileUploads } from "./editor/useEditorFileUploads";
import { useCommentsFeature } from "./editor/comments/useCommentsFeature";
import { useOffscreenPresence } from "./editor/useOffscreenPresence";
import { useFeatureFlags } from "../context/FeatureFlagsContext";
import { useAgentPresenceOverlay } from "./editor/useAgentPresenceOverlay";
import { useAgentRuntimeFeature } from "./editor/useAgentRuntimeFeature";
import { useOrchestratorThreadFeature } from "./editor/useOrchestratorThreadFeature";
import type { PreviewTransaction } from "../integrations/excalidraw/capabilities";
import { useFrameNavigator } from "./editor/frameNavigator";
import { insertWorkshopTemplate, WORKSHOP_TEMPLATES } from "./editor/workshopTemplates";
import { notify } from "../notifications";
import type { DocumentPageRequestResult } from "./editor/documentPages";
import { LaserToolbarButton } from "./editor/slots/laserToolbarButton";
import {
  applyDocumentAssetReplacement,
  type DocumentAssetReplacement,
} from "./editor/documentAssetReplacement";
export const Editor: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme } = useTheme();
  const { user, authEnabled } = useAuth();
  const [accessLevel, setAccessLevel] = useState<"none" | "view" | "comment" | "edit" | "owner">(
    "none",
  );
  const canEdit = accessLevel === "edit" || accessLevel === "owner";
  const canComment = canEdit || accessLevel === "comment";
  const [canUploadFiles, setCanUploadFiles] = useState(false);
  const [canViewComments, setCanViewComments] = useState(false);
  const [drawingName, setDrawingName] = useState("Drawing Editor");
  // Workspace context for the Canvas Shell chrome (NIL-323/NIL-344): which
  // collection this board sits in, gated server-side to the creator exactly
  // like collectionId already was -- see drawingReadRoutes.ts.
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [collectionName, setCollectionName] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [initialData, setInitialData] = useState<any>(null);
  const [isSceneLoading, setIsSceneLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSavingOnLeave, setIsSavingOnLeave] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [langCode, setLangCode] = useState(getInitialLangCode);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const previewTransaction = useRef<PreviewTransaction | null>(null);
  const isHistoryPreviewing = useRef(false);
  useEditorChrome({ drawingName });
  const me: UserIdentity = useEditorIdentity(user);
  const [isReady, setIsReady] = useState(false);
  const {
    computeElementOrderSig,
    elementVersionMap,
    hasElementChanged,
    recordElementVersion,
    recordElementVersionInfo,
  } = useEditorElementTracking();
  const isBootstrappingScene = useRef(true);
  const hasHydratedInitialScene = useRef(false);
  const isUnmounting = useRef(false);
  const latestElementsRef = useRef<readonly any[]>([]);
  const initialSceneElementsRef = useRef<readonly any[]>([]);
  const latestFilesRef = useRef<any>(null);
  const lastSyncedFilesRef = useRef<Record<string, any>>({});
  const lastSyncedElementOrderSigRef = useRef<string>("");
  const lastPersistedFilesRef = useRef<Record<string, any>>({});
  const latestAppStateRef = useRef<any>(null);
  const debouncedSaveRef = useRef<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => void)
    | null
  >(null);
  const currentDrawingVersionRef = useRef<number | null>(null);
  const lastPersistedElementsRef = useRef<readonly any[]>([]);
  const lastPersistedAppStateSigRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const suspiciousBlankLoadRef = useRef(false);
  const hasSceneChangesSinceLoadRef = useRef(false);
  const lastLocalChangeAtRef = useRef<number>(0);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const excalidrawAPI = useRef<any>(null);
  // Read through a ref, not a closure: the adapter below is built once and would
  // otherwise answer `canEdit` with whatever it was on first render -- which is
  // exactly how a read-only visitor ends up holding an editing capability.
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  /**
   * The one adapter instance in the product.
   *
   * Until now `createExcalidrawAdapter` existed only in its own test: consumers
   * held the raw handle and each reached into the editor their own way. A second
   * construction site would bring that back under a nicer name, so this is the
   * only place the adapter is built -- consumers receive the capability they
   * need as a parameter, the way `inviteHere` already does.
   *
   * `useMemo` with no dependencies is deliberate: the adapter reads the refs
   * lazily on every call, so it stays correct across editor remounts without
   * being rebuilt and handing every consumer a new object each render.
   */
  const adapter = useMemo(
    () =>
      createExcalidrawAdapter({
        api: () => excalidrawAPI.current,
        container: () => editorContainerRef.current,
        canEdit: () => canEditRef.current,
      }),
    [],
  );

  /**
   * A narrow window for the browser suite, only in development.
   *
   * The suite used to read the raw editor handle off
   * `window.__EXCALIDASH_EXCALIDRAW_API__`. That global was a debug
   * convenience that had quietly become a second way into the editor, and
   * removing it with the keystone turned four E2E jobs red without a single
   * product path being broken -- the tests had lost their vantage point, not
   * their subject.
   *
   * They get one back, but through the same boundary the product uses. A test
   * that observes through the adapter exercises it as well, which is more than
   * the raw handle ever did.
   */
  // The delivery hook is created further down; the harness reads it through
  // this ref so the effect below neither has to move nor depend on it.
  const deliveryStateRef = useRef<(() => DeliveryState) | null>(null);
  const documentPageRequestRef = useRef<
    ((elementId: string, page: number) => Promise<DocumentPageRequestResult>) | null
  >(null);
  useEffect(() => {
    // Only once the editor has actually handed its handle over. The suite uses
    // this global as its readiness signal -- the old one was set at exactly that
    // moment -- and publishing it on first render lets a spec reach for
    // `.excalidraw` before Excalidraw has mounted any DOM.
    //
    // `VITE_E2E_HARNESS_ENABLED` (NIL-649) is the second way this turns on,
    // beside plain `DEV`: a real production build (`vite build`) has
    // `import.meta.env.DEV === false`, so without this the harness -- and
    // therefore every spec that opens a board through `openEditor` -- could
    // never run against the actual built-and-served image, only the dev
    // server. It defaults to unset/false everywhere a real user's image gets
    // built (frontend/Dockerfile's ARG default, publish-images.yml, the
    // ordinary `docker-compose.yml` build); only the CI job that smoke-tests
    // the built image (`docker-compose.e2e-smoke.yml`) sets it, so shipped
    // images never carry this internal read/write surface.
    if (!(import.meta.env.DEV || import.meta.env.VITE_E2E_HARNESS_ENABLED) || !isReady) return;
    const unwrap = <T,>(result: { ok: true; value: T } | { ok: false }, fallback: T): T =>
      result.ok ? result.value : fallback;
    const openDocument = (result: ReturnType<typeof adapter.scene.readDocument>) =>
      (result.ok ? (openSceneDocument(result.value)?.elements ?? []) : []) as readonly unknown[];
    let viewportTraceTrigger = "editor-ready";
    let previousViewport = unwrap(adapter.viewport.read(), null);
    let viewportTrace: Array<{
      at: number;
      source: "editor.onScrollChange";
      trigger: string;
      previous: typeof previousViewport;
      current: typeof previousViewport;
    }> = [];
    const unsubscribeViewportTrace = adapter.viewport.subscribeScroll((current) => {
      viewportTrace.push({
        at: performance.now(),
        source: "editor.onScrollChange",
        trigger: viewportTraceTrigger,
        previous: previousViewport,
        current,
      });
      previousViewport = current;
    });
    (window as unknown as Record<string, unknown>).__EXCALIDASH_TEST__ = {
      // The document, not the projection. `summaries()` is a read model -- it
      // names geometry, frames, links and customData, and deliberately not
      // `fileId` or `status`. A spec asserting on an image's file id got
      // `undefined` from it, which looked like a broken sync and was a missing
      // field. `readDocument` is the lossless one, which is what a harness
      // observing the real scene needs.
      getSceneElements: () =>
        openDocument(adapter.scene.readDocument({ includeDeleted: false })).filter(
          (element) => !(element as { isDeleted?: boolean }).isDeleted,
        ),
      getSceneElementsIncludingDeleted: () =>
        openDocument(adapter.scene.readDocument({ includeDeleted: true })),
      getFiles: () => unwrap(adapter.files.read(), {} as Record<string, unknown>),
      getViewport: () => unwrap(adapter.viewport.read(), null),
      toViewport: (point: { x: number; y: number }) =>
        unwrap(adapter.viewport.toViewport(point as never), null),
      showViewportBounds: (bounds: readonly number[]) =>
        adapter.viewport.showBounds(bounds as never),
      markViewportTrace: (trigger: string) => {
        viewportTraceTrigger = trigger;
      },
      resetViewportTrace: (trigger: string) => {
        viewportTraceTrigger = trigger;
        previousViewport = unwrap(adapter.viewport.read(), null);
        viewportTrace = [];
      },
      getViewportTrace: () => viewportTrace,
      /**
       * The outbound queue, as a state a spec can wait for. "The peer does
       * not have the file yet" is one observation that hides three
       * different failures (never sent, sent but not acked, acked but not
       * fanned out); this lets a spec confirm each hop instead of timing
       * the last one.
       */
      getDeliveryState: () => deliveryStateRef.current?.() ?? null,
      /** NIL-570: see `mindMapScene.ts`'s own comment on why this exists. */
      getMindMapLayoutRunCount: () => mindMapLayoutRunCount(),
      getAmbientTreeDragApplyCount: () => ambientTreeDragApplyCount(),
      requestDocumentPage: (elementId: string, page: number) =>
        documentPageRequestRef.current?.(elementId, page) ??
        Promise.resolve({
          ok: false as const,
          error: { code: "not-connected", message: "Document page sharing is not connected" },
        }),
      /**
       * Writing, too. Some specs plant an element or a file to drive a live
       * path; going through `scene.apply` and `files.add` means they take the
       * route the product takes, including its version bookkeeping.
       */
      updateScene: (change: { elements?: readonly unknown[]; appState?: unknown }) => {
        if (change.elements) {
          adapter.scene.apply([
            { kind: "replaceElements", elements: change.elements as never },
          ] as never);
        }
        if (change.appState) {
          const state = change.appState as {
            collaborators?: unknown;
            selectedElementIds?: Record<string, boolean>;
          };
          // Selection is a scene op, not an app-state write: `scene.apply` has a
          // `select` kind and the capability has no setter. A spec that picks a
          // frame this way and then nudges it with the arrow keys was moving
          // nothing at all while the shim quietly ignored the field.
          if (state.selectedElementIds) {
            adapter.scene.apply([
              {
                kind: "select",
                ids: Object.keys(state.selectedElementIds).filter(
                  (id) => state.selectedElementIds?.[id],
                ),
              },
            ] as never);
          }
          // Zoom, expressed the way the boundary offers it. There is no zoom
          // setter and there should not be one: the product never sets zoom
          // directly, it shows bounds and lets the zoom follow. So the harness
          // asks for the bounds that produce the zoom it wants.
          const zoom = (change.appState as { zoom?: { value?: number } }).zoom?.value;
          if (typeof zoom === "number" && zoom > 0) {
            const current = adapter.viewport.read();
            if (current.ok) {
              const { scrollX, scrollY, width, height, zoom: was } = current.value;
              const centreX = -scrollX + width / 2 / was;
              const centreY = -scrollY + height / 2 / was;
              const halfW = width / 2 / zoom;
              const halfH = height / 2 / zoom;
              adapter.viewport.showBounds([
                centreX - halfW,
                centreY - halfH,
                centreX + halfW,
                centreY + halfH,
              ] as never);
            }
          }
          if (state.collaborators instanceof Map) {
            adapter.collaboration.patchCollaborators(
              [...state.collaborators.entries()].map(([socketId, peer]) => ({
                ...(peer as object),
                socketId,
              })) as never,
            );
          }
        }
      },
      addFiles: (files: Record<string, unknown> | readonly unknown[]) =>
        adapter.files.add((Array.isArray(files) ? files : Object.values(files)) as never),
      getAppState: () => ({
        // `activeTool` too: the sticky specs wait for the tool to arm, and a
        // surface that answers `undefined` there makes a working tool look
        // like a broken one.
        activeTool: unwrap(adapter.interaction.read(), null)?.activeTool ?? null,
        // The command-palette test observes the live Excalidraw state through
        // the adapter, rather than inferring it from a persistence request.
        gridModeEnabled: unwrap(adapter.boardSettings.read(), null)?.gridModeEnabled ?? false,
        collaborators: new Map(
          unwrap(adapter.collaboration.readCollaborators(), []).map((peer) => [
            String(peer.socketId),
            peer,
          ]),
        ),
        selectedElementIds: Object.fromEntries(
          unwrap(adapter.selection.read(), { selectedIds: [], allSelected: false }).selectedIds.map(
            (id) => [String(id), true],
          ),
        ),
      }),
    };
    return () => {
      unsubscribeViewportTrace();
      delete (window as unknown as Record<string, unknown>).__EXCALIDASH_TEST__;
    };
  }, [adapter, isReady]);
  const { resolveSafeSnapshot, normalizeImageElementStatus } = useEditorSnapshotGuards({
    lastPersistedElementsRef,
    initialSceneElementsRef,
    latestElementsRef,
  });
  const normalizeSceneForTransport = useCallback(
    (elements: readonly any[] = [], files?: Record<string, any> | null) =>
      canonicalizeStickyFontState(normalizeImageElementStatus(elements, files)),
    [normalizeImageElementStatus],
  );
  useEffect(() => {
    isUnmounting.current = false;
    return () => {
      isUnmounting.current = true;
    };
  }, []);
  const handleSocketAccessDenied = useCallback(() => {
    if (!id || !location.pathname.startsWith("/editor/")) return;
    navigate(`/shared/${id}${location.search}${location.hash}`, {
      replace: true,
    });
  }, [id, location.hash, location.pathname, location.search, navigate]);
  const {
    peers,
    agentPresence,
    connectionStatus,
    cursorChatRef,
    cursorChatDraft,
    followers,
    workshopTimer,
    documentPages,
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
  } = useEditorCollaboration({
    drawingId: id,
    collaboration: adapter.collaboration,
    files: adapter.files,
    interaction: adapter.interaction,
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
    scene: adapter.scene,
    selection: adapter.selection,
    viewport: adapter.viewport,
    onAccessDenied: handleSocketAccessDenied,
    onDrawingNameChange: setDrawingName,
  });
  useEffect(() => {
    documentPageRequestRef.current = documentPages.requestPage;
  }, [documentPages.requestPage]);
  useLibraryImportFromUrl({ ui: adapter.ui, isReady, user });
  const frames = useFrameNavigator(adapter.scene, isReady);
  const handleInsertTemplate = useCallback(
    (templateId: string) => {
      const template = WORKSHOP_TEMPLATES.find((candidate) => candidate.id === templateId);
      if (!template) return;
      const result = insertWorkshopTemplate(adapter.scene, template);
      if (!result.ok) notify("error", `Could not insert the ${template.label} template.`);
    },
    [adapter.scene],
  );
  const handleDocumentAssetReplacement = useCallback(
    async (replacement: DocumentAssetReplacement) => {
      currentDrawingVersionRef.current = Math.max(
        currentDrawingVersionRef.current ?? 0,
        replacement.drawingVersion,
      );
      const applied = await (async () => {
        isSyncing.current = true;
        try {
          return await applyDocumentAssetReplacement(adapter.scene, replacement, "immediate");
        } finally {
          isSyncing.current = false;
        }
      })();
      if (!applied.ok) {
        notify(
          "error",
          "The Markdown file was saved, but the canvas could not update. Reload the board.",
        );
        return false;
      }
      const replacementsById = new Map(
        replacement.elements.map((element) => [element.id, element] as const),
      );
      latestElementsRef.current = latestElementsRef.current.map(
        (element) => replacementsById.get(element?.id) ?? element,
      );
      replacement.elements.forEach(recordElementVersion);
      return true;
    },
    [adapter.scene, isSyncing, recordElementVersion],
  );
  const persistenceRefs = React.useMemo(
    () => ({
      currentDrawingVersion: currentDrawingVersionRef,
      debouncedSave: debouncedSaveRef,
      excalidrawAPI,
      isSyncing,
      isUnmounting,
      lastLocalChangeAt: lastLocalChangeAtRef,
      lastPersistedElements: lastPersistedElementsRef,
      lastPersistedFiles: lastPersistedFilesRef,
      lastSyncedFiles: lastSyncedFilesRef,
      latestAppState: latestAppStateRef,
      latestElements: latestElementsRef,
      latestFiles: latestFilesRef,
      saveQueue: saveQueueRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
    }),
    [isSyncing],
  );
  const {
    debouncedSave,
    debouncedSaveLibrary,
    debouncedSavePreview,
    enqueueSceneSave,
    flushPendingSceneSave,
    saveDataRef,
    savePreviewRef,
  } = useEditorPersistence({
    refs: persistenceRefs,
    scene: adapter.scene,
    fileCapability: adapter.files,
    interaction: adapter.interaction,
    user,
    normalizeImageElementStatus: normalizeSceneForTransport,
    resolveSafeSnapshot,
  });
  const prepareDocumentAssetReplacement = useCallback(async () => {
    await flushPendingSceneSave();
  }, [flushPendingSceneSave]);
  useEditorFileUploads({ drawingId: id, fileCapability: adapter.files, enabled: canUploadFiles });
  const markSceneChangedSinceLoad = useCallback(() => {
    hasSceneChangesSinceLoadRef.current = true;
  }, []);
  const { broadcastChanges, broadcastFiles, getDeliveryState } = useEditorBroadcast({
    drawingId: id,
    files: adapter.files,
    lastLocalChangeAtRef,
    lastSyncedElementOrderSigRef,
    lastSyncedFilesRef,
    lastPersistedAppStateSigRef,
    latestAppStateRef,
    latestFilesRef,
    roomJoinedRef,
    socketRef,
    debouncedSave,
    debouncedSavePreview,
    computeElementOrderSig,
    hasElementChanged,
    normalizeImageElementStatus: normalizeSceneForTransport,
    captureElementVersionInfo,
    recordElementVersionInfo,
    setHasSceneChangesSinceLoad: markSceneChangedSinceLoad,
  });
  useEffect(() => {
    deliveryStateRef.current = getDeliveryState;
  }, [getDeliveryState]);
  const { emitFilesDeltaIfNeeded, setExcalidrawAPI } = useEditorAddFilesBridge({
    fileCapability: adapter.files,
    drawingId: id,
    debouncedSaveRef,
    excalidrawAPIRef: excalidrawAPI,
    hasSceneChangesSinceLoadRef,
    isHistoryPreviewingRef: isHistoryPreviewing,
    isSyncingRef: isSyncing,
    latestAppStateRef,
    latestElementsRef,
    latestFilesRef,
    setIsReady,
    broadcastFiles,
  });
  const sceneLoaderRefs = React.useMemo(
    () => ({
      elementVersionMap,
      saveQueue: saveQueueRef,
      latestElements: latestElementsRef,
      initialSceneElements: initialSceneElementsRef,
      latestFiles: latestFilesRef,
      lastSyncedFiles: lastSyncedFilesRef,
      lastSyncedElementOrderSig: lastSyncedElementOrderSigRef,
      lastPersistedFiles: lastPersistedFilesRef,
      currentDrawingVersion: currentDrawingVersionRef,
      lastPersistedElements: lastPersistedElementsRef,
      lastPersistedAppStateSig: lastPersistedAppStateSigRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
      hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
      excalidrawAPI,
      latestAppState: latestAppStateRef,
      isBootstrappingScene,
      hasHydratedInitialScene,
    }),
    [elementVersionMap],
  );
  useEditorSceneLoader({
    id,
    user,
    location,
    navigate,
    refs: sceneLoaderRefs,
    setAccessLevel,
    setCanUploadFiles,
    setCanViewComments,
    setDrawingName,
    setCollectionId,
    setCollectionName,
    setInitialData,
    setIsReady,
    setIsSceneLoading,
    setLoadError,
    recordElementVersion,
  });
  const canvasHandlerRefs = React.useMemo(
    () => ({
      debouncedSave: debouncedSaveRef,
      excalidrawAPI,
      hasHydratedInitialScene,
      hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
      initialSceneElements: initialSceneElementsRef,
      isBootstrappingScene,
      isSyncing,
      pendingSyncFingerprint: pendingSyncFingerprintRef,
      isHistoryPreviewing,
      isUnmounting,
      lastLocalChangeAt: lastLocalChangeAtRef,
      lastPersistedAppStateSig: lastPersistedAppStateSigRef,
      latestAppState: latestAppStateRef,
      latestElements: latestElementsRef,
      latestFiles: latestFilesRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
    }),
    [isSyncing, pendingSyncFingerprintRef],
  );
  const { handleCanvasChange, handleCanvasDropCapture } = useEditorCanvasHandlers({
    canEdit,
    canUploadFiles,
    debouncedSavePreview,
    drawingId: id,
    emitFilesDeltaIfNeeded,
    isReady,
    refs: canvasHandlerRefs,
    resolveSafeSnapshot,
    broadcastChanges,
    fileCapability: adapter.files,
    scene: adapter.scene,
    viewport: adapter.viewport,
  });
  useGridModePreference({
    active: isReady && !!user,
    boardSettings: adapter.boardSettings,
    scene: adapter.scene,
  });
  const { stickyOverlay, onCanvasChange: handleChangeWithNotes } = useStickyNotesFeature({
    containerRef: editorContainerRef,
    canEdit,
    elements: () => latestElementsRef.current,
    interaction: adapter.interaction,
    isDragging: () => !!latestAppStateRef.current?.draggingElement,
    onCanvasChange: handleCanvasChange,
    scene: adapter.scene,
    selection: adapter.selection,
    ui: adapter.ui,
    viewport: adapter.viewport,
  });
  const { mindMapOverlay, onArrangeMindMap, onOpenMindMapImport } = useMindMapFeature({
    canEdit,
    scene: adapter.scene,
    selection: adapter.selection,
    viewport: adapter.viewport,
  });
  useCursorChatKey({
    containerRef: editorContainerRef,

    // View access is enough to speak: the server says so explicitly, and a
    // visitor on a read-only link is still in the meeting.
    enabled: accessLevel !== "none",
    selection: adapter.selection,
    chatRef: cursorChatRef,
  });

  const { onSceneChange: onAmbientTreeSceneChange } = useAmbientTreeDrag({
    canEdit,
    scene: adapter.scene,
    selection: adapter.selection,
  });

  const [hasSelection, setHasSelection] = useState(false);
  const forwardExcalidrawToast = useExcalidrawToastBridge();
  const handleChangeWithSelection = useCallback(
    (elements: readonly any[], appState: any, files?: Record<string, any>) => {
      forwardExcalidrawToast(appState?.toast);
      onSelectionChange(appState);
      setHasSelection(
        Object.values(appState?.selectedElementIds || {}).some((selected) => selected === true),
      );
      // Ambient tree drag first: on every board, tool-less, reading only
      // native arrow bindings (NIL-593) -- independent of the mind-map
      // feature below it, which no longer tags any node of its own (the
      // v1 mode's customData.excalidash.mindMap relationship layer is
      // torn down this schnitt; "Import mind map..." and "Arrange" both
      // read structure the same ambient way this drag hook does).
      onAmbientTreeSceneChange();
      handleChangeWithNotes(elements, appState, files);
    },
    [forwardExcalidrawToast, handleChangeWithNotes, onAmbientTreeSceneChange, onSelectionChange],
  );
  // A comment/mention/activity deep link arrives as `?thread=<rootId>`
  // (built by the Inbox and Activity pages). Captured once, then stripped
  // from the URL immediately so a refresh or browser-back does not force
  // the panel open again on its own.
  const [deepLinkThreadId] = useState(() => new URLSearchParams(location.search).get("thread"));
  useEffect(() => {
    if (!deepLinkThreadId) return;
    const params = new URLSearchParams(location.search);
    if (!params.has("thread")) return;
    params.delete("thread");
    const query = params.toString();
    navigate({ pathname: location.pathname, search: query ? `?${query}` : "" }, { replace: true });
    // Runs once: this is a one-shot consumption of the initial URL, not a
    // reaction to `location` changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { offscreenPresenceOverlay } = useOffscreenPresence({ adapter });
  // One deployment-level answer drives every agent surface below. An instance
  // that never configured a runtime shows none of them, because each would only
  // lead to a dead end.
  const { agents: agentsEnabled } = useFeatureFlags();
  const { agentPresenceOverlay } = useAgentPresenceOverlay({
    adapter,
    presence: agentPresence,
    enabled: agentsEnabled,
  });
  const { agentRuntimeOverlay, isAgentRuntimeOpen, toggleAgentRuntime, openAgentRuntime } =
    useAgentRuntimeFeature({
      adapter,
      drawingId: id,
      enabled: agentsEnabled,
    });
  const { orchestratorThreadOverlay, createThread: createOrchestratorThread } =
    useOrchestratorThreadFeature({
      adapter,
      canEdit,
      isReady,
      drawingId: id,
      socketRef,
      // In auth-disabled mode the backend supplies one stable bootstrap
      // subject even though AuthContext intentionally has no User row. This
      // value only enables local UI; every API call derives the real owner id
      // server-side and never trusts it.
      currentUserId: user?.id ?? (authEnabled === false ? "bootstrap" : null),
      enabled: agentsEnabled,
    });
  const { commentsOverlay, isCommentsOpen, toggleComments, unresolvedCommentCount } =
    useCommentsFeature({
      drawingId: id,
      adapter,
      socketRef,
      isReady,
      accessLevel,
      enabled: canViewComments,
      canComment,
      canModerate: canEdit,
      currentUserId: user?.id ?? null,
      hasSelection,
      deepLinkThreadId,
    });
  const commandRefs = React.useMemo(
    () => ({
      excalidrawAPI,
      hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
      latestElements: latestElementsRef,
      latestFiles: latestFilesRef,
      saveData: saveDataRef,
      savePreview: savePreviewRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
    }),
    [saveDataRef, savePreviewRef],
  );
  const {
    handleBackClick,
    handleExportClick,
    handleLibraryChange,
    handleRenameStart,
    handleRenameSubmit,
  } = useEditorCommands({
    boardSettings: adapter.boardSettings,
    files: adapter.files,
    canEdit,
    debouncedSaveLibrary,
    drawingId: id,
    drawingName,
    enqueueSceneSave,
    isSavingOnLeave,
    newName,
    refs: commandRefs,
    resolveSafeSnapshot,
    setDrawingName,
    setIsRenaming,
    setIsSavingOnLeave,
    setNewName,
    user,
  });

  return (
    <>
      <EditorView
        id={id}
        accessLevel={accessLevel}
        canEdit={canEdit}
        canComment={canComment}
        canUploadFiles={canUploadFiles}
        canViewComments={canViewComments}
        drawingName={drawingName}
        collectionId={collectionId}
        collectionName={collectionName}
        editorContainerRef={editorContainerRef}
        followers={followers}
        initialData={initialData}
        inviteHere={inviteHere}
        cursorChatDraft={cursorChatDraft}
        onCursorChatType={(text: string) => cursorChatRef.current?.type(text)}
        onCursorChatClose={() => cursorChatRef.current?.close()}
        isRenaming={isRenaming}
        isSavingOnLeave={isSavingOnLeave}
        isSceneLoading={isSceneLoading}
        langCode={langCode}
        loadError={loadError}
        newName={newName}
        peers={peers}
        connectionStatus={connectionStatus}
        theme={theme}
        workshopTimer={workshopTimer}
        documentPages={documentPages}
        documentEdits={documentEdits}
        onBeforeDocumentAssetReplacement={prepareDocumentAssetReplacement}
        onDocumentAssetReplacement={handleDocumentAssetReplacement}
        presenting={{ ...presenting, canTakeover: accessLevel === "owner" }}
        frames={frames}
        voting={{ ...voting, canModerate: canEdit }}
        onInsertTemplate={handleInsertTemplate}
        onBackClick={handleBackClick}
        onCanvasChange={handleChangeWithSelection}
        stickyOverlay={stickyOverlay}
        mindMapOverlay={mindMapOverlay}
        onArrangeMindMap={onArrangeMindMap}
        onOpenMindMapImport={onOpenMindMapImport}
        commentsOverlay={commentsOverlay}
        offscreenPresenceOverlay={offscreenPresenceOverlay}
        agentPresenceOverlay={agentPresenceOverlay}
        isCommentsOpen={isCommentsOpen}
        onToggleComments={toggleComments}
        unresolvedCommentCount={unresolvedCommentCount}
        isAgentRuntimeOpen={isAgentRuntimeOpen}
        onToggleAgentRuntime={toggleAgentRuntime}
        onOpenAgentRuntime={openAgentRuntime}
        onCreateOrchestratorThread={createOrchestratorThread}
        agentsEnabled={agentsEnabled}
        onCanvasDropCapture={handleCanvasDropCapture}
        onExportClick={handleExportClick}
        onLibraryChange={handleLibraryChange}
        onNavigateHome={() => navigate("/")}
        onNewNameChange={setNewName}
        onPointerUpdate={onPointerUpdate}
        onRenameBlur={() => setIsRenaming(false)}
        onRenameStart={handleRenameStart}
        onRenameSubmit={handleRenameSubmit}
        onSetExcalidrawAPI={setExcalidrawAPI}
        onSetLangCode={setLangCode}
        onShareOpen={() => setIsShareOpen(true)}
        onHistoryOpen={() => setIsHistoryOpen(true)}
      />
      {agentRuntimeOverlay}
      {orchestratorThreadOverlay}
      {canEdit ? (
        <LaserToolbarButton containerRef={editorContainerRef} interaction={adapter.interaction} />
      ) : null}
      <EditorDialogs
        drawingId={id}
        drawingName={drawingName}
        history={adapter.history}
        isHistoryOpen={isHistoryOpen}
        isShareOpen={isShareOpen}
        previewTransactionRef={previewTransaction}
        isHistoryPreviewingRef={isHistoryPreviewing}
        onCloseHistory={() => setIsHistoryOpen(false)}
        onCloseShare={() => setIsShareOpen(false)}
      />
    </>
  );
};
