import React from "react";
import { Toaster, toast } from "sonner";
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
import { PresentationOverlay, type PresentationUiState } from "./PresentationOverlay";
import { VotingOverlay, type VotingUiState } from "./VotingOverlay";
import type { FrameSummary } from "./frameNavigator";
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
  accessLevel: "none" | "view" | "comment" | "edit" | "owner";
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
  presenting: PresentationUiState;
  frames: readonly FrameSummary[];
  voting: VotingUiState;
  onInsertTemplate: (templateId: string) => void;
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
  /**
   * The comment panel + canvas markers, a free-floating ui.overlayRoot()
   * portal like stickyOverlay above it -- not part of the chromeSlots.tsx
   * registries, which only cover MainMenu/header-control/Footer. The toggle
   * button that opens it IS a chromeSlots entry (see slots/commentsMenuEntry.tsx);
   * isCommentsOpen/unresolvedCommentCount/onToggleComments below feed that
   * entry's ChromeSlotContext.
   */
  commentsOverlay?: React.ReactNode;
  isCommentsOpen: boolean;
  unresolvedCommentCount: number;
  onToggleComments: () => void;
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
  presenting,
  frames,
  voting,
  onInsertTemplate,
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
  commentsOverlay,
  isCommentsOpen,
  unresolvedCommentCount,
  onToggleComments,
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
    isCommentsOpen,
    unresolvedCommentCount,
    presenting: {
      status: presenting.snapshot.status,
      isSelf: presenting.isSelf,
      presenterName: presenting.snapshot.presenterName,
      start: presenting.start,
      stop: presenting.stop,
    },
    onStartVoteCompose: voting.openCompose,
    onInsertTemplate,
    onBackClick,
    onNewNameChange,
    onRenameBlur,
    onRenameStart,
    onRenameSubmit,
    onExportClick,
    onShareOpen,
    onHistoryOpen,
    onSetLangCode,
    onToggleComments,
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
            // Excalidraw's `isCollaborating` prop creates a second standalone
            // laser island. ExcaliDash supplies the same action through its
            // toolbar capability instead (laserToolbarButton.tsx), where it is
            // available alone and sits directly after Sticky Note.
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
                    // The server answers every request with an ack, including a
                    // refusal (the widget's server row is gone, the page no
                    // longer exists). useSharedDocumentPage only reads the
                    // promise to clear its own pending flag -- a `{ok: false}`
                    // resolution otherwise reaches nobody, and the click that
                    // caused it just does nothing. Surfacing it here is the
                    // same pattern reportCapabilityFailure uses elsewhere in
                    // this editor for a result that would otherwise go unread.
                    onRequestPage: (elementId, page) =>
                      documentPages.requestPage(elementId, page).then((result) => {
                        if (!result.ok) toast.error(result.error.message);
                        return result;
                      }),
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
          <PresentationOverlay container={excalidrawRoot} frames={frames} presenting={presenting} />
          <VotingOverlay container={excalidrawRoot} voting={voting} />
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
          {commentsOverlay}
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
