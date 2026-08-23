import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { createExcalidrawAdapter } from "../integrations/excalidraw";
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
import { useStickyNotesFeature } from "../sticky";
import { useEditorCommands } from "./editor/useEditorCommands";
import { useEditorElementTracking } from "./editor/useEditorElementTracking";
import { useEditorBroadcast } from "./editor/useEditorBroadcast";
import { useEditorAddFilesBridge } from "./editor/useEditorAddFilesBridge";
import type { PreviewTransaction } from "../integrations/excalidraw/capabilities";
export const Editor: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme } = useTheme();
  const { user } = useAuth();
  const [accessLevel, setAccessLevel] = useState<"none" | "view" | "edit" | "owner">("none");
  const canEdit = accessLevel === "edit" || accessLevel === "owner";
  const [drawingName, setDrawingName] = useState("Drawing Editor");
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
  const { computeElementOrderSig, elementVersionMap, hasElementChanged, recordElementVersion } =
    useEditorElementTracking();
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
  const { resolveSafeSnapshot, normalizeImageElementStatus } = useEditorSnapshotGuards({
    lastPersistedElementsRef,
    initialSceneElementsRef,
    latestElementsRef,
  });
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
    cursorChatRef,
    cursorChatDraft,
    followers,
    workshopTimer,
    documentPages,
    socketRef,
    isSyncing,
    onPointerUpdate,
    onSelectionChange,
    inviteHere,
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
    computeElementOrderSig,
    recordElementVersion,
    scene: adapter.scene,
    selection: adapter.selection,
    viewport: adapter.viewport,
    onAccessDenied: handleSocketAccessDenied,
    onDrawingNameChange: setDrawingName,
  });
  useLibraryImportFromUrl({ ui: adapter.ui, isReady, user });
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
    saveDataRef,
    savePreviewRef,
  } = useEditorPersistence({
    refs: persistenceRefs,
    scene: adapter.scene,
    fileCapability: adapter.files,
    interaction: adapter.interaction,
    user,
    normalizeImageElementStatus,
    resolveSafeSnapshot,
  });
  const markSceneChangedSinceLoad = useCallback(() => {
    hasSceneChangesSinceLoadRef.current = true;
  }, []);
  const { broadcastChanges, broadcastFiles } = useEditorBroadcast({
    drawingId: id,
    files: adapter.files,
    lastLocalChangeAtRef,
    lastSyncedElementOrderSigRef,
    lastSyncedFilesRef,
    lastPersistedAppStateSigRef,
    latestAppStateRef,
    latestFilesRef,
    socketRef,
    debouncedSave,
    debouncedSavePreview,
    computeElementOrderSig,
    hasElementChanged,
    normalizeImageElementStatus,
    recordElementVersion,
    setHasSceneChangesSinceLoad: markSceneChangedSinceLoad,
  });
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
    setDrawingName,
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
      isHistoryPreviewing,
      isUnmounting,
      lastLocalChangeAt: lastLocalChangeAtRef,
      lastPersistedAppStateSig: lastPersistedAppStateSigRef,
      latestAppState: latestAppStateRef,
      latestElements: latestElementsRef,
      latestFiles: latestFilesRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
    }),
    [isSyncing],
  );
  const { handleCanvasChange, handleCanvasDropCapture } = useEditorCanvasHandlers({
    canEdit,
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
  const { stickyOverlay, onCanvasChange: handleChangeWithNotes } = useStickyNotesFeature({
    containerRef: editorContainerRef,
    canEdit,
    elements: () => latestElementsRef.current,
    interaction: adapter.interaction,
    isDragging: () => !!latestAppStateRef.current?.draggingElement,
    onCanvasChange: handleCanvasChange,
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

  const handleChangeWithSelection = useCallback(
    (elements: readonly any[], appState: any, files?: Record<string, any>) => {
      onSelectionChange(appState);
      handleChangeWithNotes(elements, appState, files);
    },
    [handleChangeWithNotes, onSelectionChange],
  );
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
        drawingName={drawingName}
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
        theme={theme}
        workshopTimer={workshopTimer}
        documentPages={documentPages}
        onBackClick={handleBackClick}
        onCanvasChange={handleChangeWithSelection}
        stickyOverlay={stickyOverlay}
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
