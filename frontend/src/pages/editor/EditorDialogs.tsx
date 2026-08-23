import React from "react";
import { HISTORY } from "../../integrations/excalidraw/elements";
import { ShareModal } from "../../components/ShareModal";
import { HistoryPanel } from "../../components/HistoryPanel";

type PreviewBackup = {
  elements: readonly any[];
  appState: any;
  files: any;
};

type EditorDialogsProps = {
  drawingId?: string;
  drawingName: string;
  excalidrawAPIRef: React.MutableRefObject<any>;
  isHistoryOpen: boolean;
  isShareOpen: boolean;
  previewBackupRef: React.MutableRefObject<PreviewBackup | null>;
  isHistoryPreviewingRef: React.MutableRefObject<boolean>;
  onCloseHistory: () => void;
  onCloseShare: () => void;
};

export const EditorDialogs: React.FC<EditorDialogsProps> = ({
  drawingId,
  drawingName,
  excalidrawAPIRef,
  isHistoryOpen,
  isShareOpen,
  previewBackupRef,
  isHistoryPreviewingRef,
  onCloseHistory,
  onCloseShare,
}) => {
  if (!drawingId) return null;

  return (
    <>
      <ShareModal
        drawingId={drawingId}
        drawingName={drawingName}
        isOpen={isShareOpen}
        onClose={onCloseShare}
      />
      <HistoryPanel
        drawingId={drawingId}
        isOpen={isHistoryOpen}
        onClose={onCloseHistory}
        onPreview={(snapshot) => {
          const excalidrawAPI = excalidrawAPIRef.current;
          if (!excalidrawAPI) return;
          if (snapshot) {
            isHistoryPreviewingRef.current = true;
            if (!previewBackupRef.current) {
              previewBackupRef.current = {
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                appState: excalidrawAPI.getAppState(),
                files: excalidrawAPI.getFiles(),
              };
            }
            const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
            const files = snapshot.files || {};
            if (Object.keys(files).length > 0) {
              excalidrawAPI.addFiles(Object.values(files));
            }
            excalidrawAPI.updateScene({
              elements,
              appState: {
                ...snapshot.appState,
                collaborators: undefined,
              },
              captureUpdate: HISTORY.never,
            });
            return;
          }
          if (previewBackupRef.current) {
            excalidrawAPI.updateScene({
              elements: previewBackupRef.current.elements as any[],
              appState: previewBackupRef.current.appState,
              captureUpdate: HISTORY.never,
            });
            if (previewBackupRef.current.files) {
              excalidrawAPI.addFiles(Object.values(previewBackupRef.current.files));
            }
            previewBackupRef.current = null;
          }
          // updateScene notifies onChange as part of the scene update. Release
          // the guard on the next task so the restoration callback cannot be
          // mistaken for a user edit either.
          window.setTimeout(() => {
            isHistoryPreviewingRef.current = false;
          }, 0);
        }}
        onRestore={() => {
          isHistoryPreviewingRef.current = false;
          previewBackupRef.current = null;
          window.location.reload();
        }}
      />
    </>
  );
};
