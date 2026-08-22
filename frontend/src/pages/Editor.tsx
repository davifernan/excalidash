import React, { useCallback, useEffect, useState, useRef } from "react";
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
  const [loadAttempt, setLoadAttempt] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSavingOnLeave, setIsSavingOnLeave] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [langCode, setLangCode] = useState(getInitialLangCode);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const previewBackup = useRef<{
    elements: readonly any[];
    appState: any;
    files: any;
  } | null>(null);
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
    onAccessDenied: handleSocketAccessDenied,
  });
  useLibraryImportFromUrl({ excalidrawAPIRef: excalidrawAPI, isReady, user });
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
    user,
    normalizeImageElementStatus,
    resolveSafeSnapshot,
  });
  const markSceneChangedSinceLoad = useCallback(() => {
    hasSceneChangesSinceLoadRef.current = true;
  }, []);
  const { broadcastChanges, broadcastFiles } = useEditorBroadcast({
    drawingId: id,
    excalidrawAPI,
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
    setLoadAttempt,
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
  });
  const { stickyOverlay, onCanvasChange: handleChangeWithNotes } = useStickyNotesFeature({
    excalidrawAPI,
    containerRef: editorContainerRef,
    canEdit,
    onCanvasChange: handleCanvasChange,
  });
  useCursorChatKey({
    containerRef: editorContainerRef,

    // View access is enough to speak: the server says so explicitly, and a
    // visitor on a read-only link is still in the meeting.
    enabled: accessLevel !== "none",
    excalidrawAPI,
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
        loadAttempt={loadAttempt}
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
        excalidrawAPIRef={excalidrawAPI}
        isHistoryOpen={isHistoryOpen}
        isShareOpen={isShareOpen}
        previewBackupRef={previewBackup}
        isHistoryPreviewingRef={isHistoryPreviewing}
        onCloseHistory={() => setIsHistoryOpen(false)}
        onCloseShare={() => setIsShareOpen(false)}
      />
    </>
  );
};
