import React from "react";
import { Excalidraw, Footer, MainMenu } from "@excalidraw/excalidraw";
import { ArrowLeft, Download, History, LocateFixed, Share2 } from "lucide-react";
import { Toaster } from "sonner";
import { LanguageSelector } from "../../components/LanguageSelector";
import { UIOptions } from "./shared";
import { AssetWidget } from "./AssetWidget";
import { getAssetWidgetData, validateEmbeddableLink } from "./pdfWidgetElements";
import { EditorTopLeft } from "./EditorTopLeft";
import { EditorTopRight } from "./EditorTopRight";
import { useExcalidrawRoot } from "./useExcalidrawRoot";
import { useExcalidrawUiState } from "./useExcalidrawUiState";
import type { Peer } from "./useEditorCollaboration";
import type { Follower } from "./followMode";
import type { WorkshopTimerController } from "./workshopTimer";
import type { DocumentPageController } from "./documentPages";
import { WorkshopTimerWidget } from "./WorkshopTimerWidget";
import { InviteHereOverlay, type InviteHereUiState } from "./InviteHereOverlay";
import { CursorChatComposer } from "./CursorChatComposer";
import { MobileTimerCorner } from "./MobileTimerCorner";

type EditorViewProps = {
  id?: string;
  accessLevel: "none" | "view" | "edit" | "owner";
  canEdit: boolean;
  drawingName: string;
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

const describeFollowers = (followers: Follower[]): string | null => {
  if (followers.length === 0) return null;
  if (followers.length === 1) return `${followers[0].name} is following you`;
  return `${followers.length} people are following you`;
};

export const EditorView: React.FC<EditorViewProps> = ({
  id,
  accessLevel,
  canEdit,
  drawingName,
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
  const { zenMode, mobile } = useExcalidrawUiState(editorContainerRef);

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
          <Excalidraw
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
            // Excalidraw hides its own laser pointer until it believes a session
            // is live. The pointer payload already carries `tool: "laser"` end to
            // end, so the only thing missing was this admission that someone else
            // is here. Alone on a board a laser points at nobody, hence peers.
            isCollaborating={peers.length > 0}
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
                showInvite={canEdit && peers.length > 0}
                inviteHere={inviteHere}
                showShare={accessLevel === "owner" && !!id}
                onShareOpen={onShareOpen}
              />
            )}
          >
            {/*
              The timer lives at the bottom, in the Footer slot Excalidraw
              offers and we had never filled. It belongs there rather than in
              the top-right cluster: that column is capped near 275px and every
              button in it competes with the avatar list, which collapses the
              moment it drops below 76px. A countdown is ambient anyway -- you
              glance at it, you do not hunt for it.
            */}
            {mobile ? null : (
              <Footer>
                <WorkshopTimerWidget timer={workshopTimer} canEdit={canEdit} />
              </Footer>
            )}
            <MainMenu>
              {/*
                The way back, in the one place that exists at every window size.
                On the mobile layout the island stands down so it does not cover
                Excalidraw's tool row, and this becomes the only route home.
              */}
              <MainMenu.Item onSelect={onBackClick} icon={<ArrowLeft size={16} />}>
                Back to dashboard
              </MainMenu.Item>
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ToggleTheme />
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.Item onSelect={onExportClick} icon={<Download size={16} />}>
                Export drawing
              </MainMenu.Item>
              {canEdit && id ? (
                <MainMenu.Item onSelect={onHistoryOpen} icon={<History size={16} />}>
                  Version history
                </MainMenu.Item>
              ) : null}
              {/*
                Also in the menu, because the island stands down on the mobile
                layout: Excalidraw's tool row fills the width there and an island
                beside it pushes tools off the screen.
              */}
              {accessLevel === "owner" && id ? (
                <MainMenu.Item onSelect={onShareOpen} icon={<Share2 size={16} />}>
                  Share
                </MainMenu.Item>
              ) : null}
              {canEdit && peers.length > 0 ? (
                <MainMenu.Item onSelect={inviteHere.invite} icon={<LocateFixed size={16} />}>
                  Invite everyone here
                </MainMenu.Item>
              ) : null}
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.Help />
              <MainMenu.Separator />
              <MainMenu.ItemCustom>
                <LanguageSelector langCode={langCode} onChange={onSetLangCode} />
              </MainMenu.ItemCustom>
            </MainMenu>
          </Excalidraw>
          {/*
            On the mobile layout Excalidraw renders no Footer at all, so the
            timer would simply not exist there -- and the top row is far too
            narrow to take it: putting it in the island pushed four tools off
            the screen. It gets its own corner instead, above Excalidraw's own
            bottom bar.
          */}
          {mobile ? (
            <MobileTimerCorner container={excalidrawRoot}>
              <WorkshopTimerWidget timer={workshopTimer} canEdit={canEdit} />
            </MobileTimerCorner>
          ) : null}
          <EditorTopLeft
            container={excalidrawRoot}
            zenMode={zenMode}
            mobile={mobile}
            drawingName={drawingName}
            canEdit={canEdit}
            isRenaming={isRenaming}
            isSavingOnLeave={isSavingOnLeave}
            newName={newName}
            onBackClick={onBackClick}
            onNewNameChange={onNewNameChange}
            onRenameBlur={onRenameBlur}
            onRenameStart={onRenameStart}
            onRenameSubmit={onRenameSubmit}
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
