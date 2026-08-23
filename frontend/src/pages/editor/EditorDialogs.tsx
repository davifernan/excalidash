import React from "react";
import { ShareModal } from "../../components/ShareModal";
import { HistoryPanel } from "../../components/HistoryPanel";
import { sealSceneDocument } from "../../integrations/excalidraw/adapter";
import type {
  HistoryCapability,
  PreviewTransaction,
} from "../../integrations/excalidraw/capabilities";

type EditorDialogsProps = {
  drawingId?: string;
  drawingName: string;
  history: HistoryCapability;
  isHistoryOpen: boolean;
  isShareOpen: boolean;
  previewTransactionRef: React.MutableRefObject<PreviewTransaction | null>;
  isHistoryPreviewingRef: React.MutableRefObject<boolean>;
  onCloseHistory: () => void;
  onCloseShare: () => void;
};

export const EditorDialogs: React.FC<EditorDialogsProps> = ({
  drawingId,
  drawingName,
  history,
  isHistoryOpen,
  isShareOpen,
  previewTransactionRef,
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
        onPreview={async (snapshot) => {
          if (snapshot) {
            isHistoryPreviewingRef.current = true;
            if (previewTransactionRef.current) {
              const restored = await previewTransactionRef.current.restore();
              if (!restored.ok) {
                console.error("[Editor] Failed to restore history preview", restored);
                isHistoryPreviewingRef.current = false;
                return;
              }
              previewTransactionRef.current = null;
            }
            const preview = await history.beginPreview(
              sealSceneDocument({
                elements: (Array.isArray(snapshot.elements) ? snapshot.elements : []) as Record<
                  string,
                  unknown
                >[],
                appState: snapshot.appState || {},
                files: snapshot.files || {},
              }),
            );
            if (!preview.ok) {
              console.error("[Editor] Failed to begin history preview", preview);
              isHistoryPreviewingRef.current = false;
              return;
            }
            previewTransactionRef.current = preview.value;
            return;
          }
          if (previewTransactionRef.current) {
            const restored = await previewTransactionRef.current.restore();
            if (!restored.ok) {
              console.error("[Editor] Failed to restore history preview", restored);
            }
            previewTransactionRef.current = null;
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
          previewTransactionRef.current = null;
          window.location.reload();
        }}
      />
    </>
  );
};
