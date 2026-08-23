import React from "react";
import { Toaster } from "sonner";
import { ExcalidrawHost } from "../../integrations/excalidraw/ExcalidrawHost";
import { UIOptions } from "./shared";
import { AssetWidget } from "./AssetWidget";
import { getAssetWidgetData, validateEmbeddableLink } from "./pdfWidgetElements";
import { EditorTopRight } from "./EditorTopRight";
import { useExcalidrawRoot } from "./useExcalidrawRoot";
import { useExcalidrawUiState } from "./useExcalidrawUiState";
import type { Peer } from "./useEditorCollaboration";
import type { Follower } from "./followMode";
import type { WorkshopTimerController } from "./workshopTimer";
import type { DocumentPageController } from "./documentPages";
import { WorkshopTimerCorner } from "./WorkshopTimerCorner";
import { InviteHereOverlay, type InviteHereUiState } from "./InviteHereOverlay";
import { CursorChatComposer } from "./CursorChatComposer";
import {
  followerNotice as describeFollowers,
  renderFooterEntries,
  renderMainMenuEntries,
  type ChromeSlotContext,
} from "./chromeSlots";
import { EditorMenu as MainMenu } from "../../integrations/excalidraw/slots";
import "./editorChrome.css";

type EditorViewProps = {
  id?: string;
  accessLevel: "none" | "view" | "edit" | "owner";
  canEdit: boolean;
  drawingName: string;
  collectionId: string | null;
  collectionName: string | null;
  editorContainerRef: React.RefObject<HTMLDivElement>;
  followers: Follower[];
  initialData: any;
  isRenaming: boolean;
  isSavingOnLeave: boolean;
  isSceneLoading: boolean;
  langCode: string;
  loadError: string | null;
  newName: string;
  peers: Peer[];
  theme: string;
  workshopTimer: WorkshopTimerController;
  documentPages: DocumentPageController;
  inviteHere: InviteHereUiState;
  cursorChatDraft: string | null;
  onCursorChatType: (text: string) => void;
  onCursorChatClose: () => void;
  onBackClick: () => void;
  onCanvasChange: (elements: readonly any[], appState: any, files?: Record<string, any>) => void;
  stickyOverlay?: React.ReactNode;
  onCanvasDropCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onExportClick: () => void;
  onLibraryChange: (items: readonly any[]) => void;
  onNavigateHome: () => void;
  onNewNameChange: (value: string) => void;
  onPointerUpdate: (payload: any) => void;
  onRenameBlur: () => void;
  onRenameStart: () => void;
  onRenameSubmit: (event: React.FormEvent) => void;
  onSetExcalidrawAPI: (api: any) => void;
  onSetLangCode: (langCode: string) => void;
  onShareOpen: () => void;
  onHistoryOpen: () => void;
};

export const EditorView: React.FC<EditorViewProps> = ({
  id,
  accessLevel,
  canEdit,
  drawingName,
  collectionId,
  collectionName,
  editorContainerRef,
  followers,
  initialData,
  isRenaming,
  isSavingOnLeave,
  isSceneLoading,
  langCode,
  loadError,
  newName,
  peers,
  theme,
  workshopTimer,
  documentPages,
  inviteHere,
  cursorChatDraft,
  onCursorChatType,
  onCursorChatClose,
  onBackClick,
  onCanvasChange,
  onCanvasDropCapture,
  stickyOverlay,
  onExportClick,
  onLibraryChange,
  onNavigateHome,
  onNewNameChange,
  onPointerUpdate,
  onRenameBlur,
  onRenameStart,
  onRenameSubmit,
  onSetExcalidrawAPI,
  onSetLangCode,
  onShareOpen,
  onHistoryOpen,
}) => {
  const excalidrawRoot = useExcalidrawRoot(editorContainerRef);
  // Zen mode is handled by Excalidraw itself for everything rendered through
  // its own slots (MainMenu, renderTopRightUI both carry
  // `zen-mode-transition` already); this component no longer has a floating
  // island of its own that would need to hide independently.
  const { mobile } = useExcalidrawUiState(editorContainerRef);

  const chromeCtx: ChromeSlotContext = {
    id,
    accessLevel,
    canEdit,
    mobile,
    drawingName,
    collectionId,
    collectionName,
    isRenaming,
    isSavingOnLeave,
    newName,
    peers,
    followers,
    inviteHere,
    langCode,
    onBackClick,
    onNewNameChange,
    onRenameBlur,
    onRenameStart,
    onRenameSubmit,
    onExportClick,
    onShareOpen,
    onHistoryOpen,
    onSetLangCode,
  };

  return (
    // The canvas fills the window and never changes size again. The old header
    // pushed it down by 4rem and animated the height back on every toggle, which
    // re-rendered the whole scene, shifted what you were looking at, and made
    // Excalidraw's own toolbar hop 64px. Chrome floats above it instead.
    <div
      ref={editorContainerRef}
      className="absolute inset-0 w-full overflow-hidden bg-white dark:bg-neutral-950"
      style={{ height: "100dvh" }}
      onDropCapture={onCanvasDropCapture}
    >
      {loadError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white dark:bg-neutral-950 px-6">
          <div className="text-center">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              Unable to open drawing
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{loadError}</p>
          </div>
          <button
            onClick={onNavigateHome}
            className="px-4 py-2 rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 font-semibold hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
          >
            Back to dashboard
          </button>
        </div>
      ) : initialData ? (
        <>
          <ExcalidrawHost
            key={id}
            theme={theme === "dark" ? "dark" : "light"}
            langCode={langCode}
            initialData={initialData}
            onChange={onCanvasChange}
            onPointerUpdate={onPointerUpdate}
            onLibraryChange={onLibraryChange}
            excalidrawAPI={onSetExcalidrawAPI}
            UIOptions={UIOptions}
            viewModeEnabled={!canEdit}
            // Always on, not `peers.length > 0` (NIL-374): Excalidraw shows its
            // standalone laser toggle only while this is true, and that toggle
            // is now the *only* way to the laser tool -- the always-present
            // duplicate in the extra-tools flyout is hidden in
            // editorChrome.css. A laser control that vanished the moment you
            // are alone on a board would be a regression, not a cleanup.
            // Nothing else in this application reads `isCollaborating`: the
            // presence pill and avatar list key off `collaborators.size`, and
            // this application never renders Excalidraw's default welcome
            // screen, the prop's only other consumer.
            isCollaborating
            validateEmbeddable={validateEmbeddableLink}
            renderEmbeddable={(element, appState) => {
              const data = getAssetWidgetData(element);
              return data && id ? (
                <AssetWidget
                  data={data}
                  drawingId={id}
                  theme={appState.theme}
                  sharing={{
                    elementId: element.id,
                    sharedPage: documentPages.pages[element.id]?.page,
                    canControl: canEdit,
                    onRequestPage: documentPages.requestPage,
                  }}
                />
              ) : null;
            }}
            renderTopRightUI={(isMobile) => (
              <EditorTopRight
                isMobile={isMobile}
                followerNotice={describeFollowers(followers)}
                ctx={chromeCtx}
              />
            )}
          >
            {renderFooterEntries(chromeCtx)}
            <MainMenu>{renderMainMenuEntries(chromeCtx)}</MainMenu>
          </ExcalidrawHost>
          {/*
            One free-floating widget for every layout, portalled into
            Excalidraw's own root so it inherits colour tokens and
            `--ui-pointerEvents`. See WorkshopTimerCorner.tsx for why this
            replaced the Footer-slot desktop copy and the separate mobile
            corner it used to need.
          */}
          <WorkshopTimerCorner
            container={excalidrawRoot}
            drawingId={id}
            canEdit={canEdit}
            timer={workshopTimer}
          />
          {inviteHere.invitation ? (
            <InviteHereOverlay
              key={inviteHere.invitation.invitationId}
              container={excalidrawRoot}
              invitation={inviteHere.invitation}
              onAccept={inviteHere.accept}
              onDecline={inviteHere.decline}
            />
          ) : null}
          <CursorChatComposer
            container={excalidrawRoot}
            draft={cursorChatDraft}
            onType={onCursorChatType}
            onClose={onCursorChatClose}
          />
          {stickyOverlay}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500 dark:text-gray-400">
          <span className="text-sm font-medium">
            {isSceneLoading ? "Loading drawing..." : "Preparing canvas..."}
          </span>
        </div>
      )}
      <Toaster position="bottom-center" />
    </div>
  );
};
