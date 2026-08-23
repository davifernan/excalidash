import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { Socket } from "socket.io-client";
import { toast } from "sonner";
import * as commentsApi from "../../../api/comments";
import type { ExcalidrawAdapter } from "../../../integrations/excalidraw/capabilities";
import type { ElementId } from "../../../integrations/excalidraw/types";
import { useComments } from "./useComments";
import { useCommentPlacement } from "./useCommentPlacement";
import { CommentPanel } from "./CommentPanel";
import { CommentMarkers } from "./CommentMarkers";

type UseCommentsFeatureInput = {
  drawingId?: string;
  adapter: ExcalidrawAdapter;
  socketRef: MutableRefObject<Socket | null>;
  isReady: boolean;
  accessLevel: "none" | "view" | "comment" | "edit" | "owner";
  canComment: boolean;
  canModerate: boolean;
  currentUserId: string | null;
  hasSelection: boolean;
  /** `?thread=<rootId>` from a notification/activity deep link, or null. */
  deepLinkThreadId?: string | null;
};

export const useCommentsFeature = ({
  drawingId,
  adapter,
  socketRef,
  isReady,
  accessLevel,
  canComment,
  canModerate,
  currentUserId,
  hasSelection,
  deepLinkThreadId,
}: UseCommentsFeatureInput) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const comments = useComments({ drawingId, canComment, socketRef, isReady });
  const reportCapabilityFailure = useCallback((seam: string) => {
    console.warn("[Comments] capability failed:", seam);
    toast.error("Could not read the canvas for this comment.");
  }, []);
  const placement = useCommentPlacement({
    interaction: adapter.interaction,
    selection: adapter.selection,
    scene: adapter.scene,
    onCapabilityFailure: reportCapabilityFailure,
  });

  // A live pointer down while placing arms this component regardless of
  // whether the panel is open, so "pin a point" can be started from a
  // collapsed panel too.
  useEffect(() => {
    if (placement.draftAnchor) setIsOpen(true);
  }, [placement.draftAnchor]);

  // Record the visit once per mount, for "since you were last here".
  useEffect(() => {
    if (!drawingId || accessLevel === "none") return;
    void commentsApi.recordDrawingVisit(drawingId);
  }, [drawingId, accessLevel]);

  // Resolve a `?thread=` deep link once its target actually shows up in the
  // loaded thread list: open the panel, select it, and get it on screen. If
  // the thread never appears -- deleted, wrong board, no access -- this
  // simply never fires, which is the intended "degrade to board context"
  // instead of an error: the board itself still opened correctly.
  const resolvedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkThreadId || resolvedDeepLink.current === deepLinkThreadId) return;
    const thread = comments.threads.find((t) => t.root.id === deepLinkThreadId);
    if (!thread) return;
    resolvedDeepLink.current = deepLinkThreadId;
    setActiveThreadId(thread.root.id);
    setIsOpen(true);
    if (thread.root.elementId) {
      const result = adapter.viewport.scrollToElement(thread.root.elementId as ElementId);
      if (result.ok) return;
    }
    if (thread.root.anchorX !== null && thread.root.anchorY !== null) {
      const pad = 150;
      adapter.viewport.showBounds(
        [
          thread.root.anchorX - pad,
          thread.root.anchorY - pad,
          thread.root.anchorX + pad,
          thread.root.anchorY + pad,
        ],
        { animate: true },
      );
    }
    // A thread with neither a live element nor an anchor point (element
    // deleted, no point ever stored) still opens in the panel above -- just
    // without a viewport jump. That is the anchor-survival decision.
  }, [deepLinkThreadId, comments.threads, adapter]);

  const toggleOpen = useCallback(() => setIsOpen((v) => !v), []);

  const overlay = useMemo(() => {
    const rootResult = adapter.ui.overlayRoot();
    if (!rootResult.ok) return null;
    return createPortal(
      <div className="absolute inset-0 pointer-events-none">
        <CommentMarkers
          threads={comments.threads}
          scene={adapter.scene}
          viewport={adapter.viewport}
          activeThreadId={activeThreadId}
          onSelectThread={(id) => {
            setActiveThreadId(id);
            setIsOpen(true);
          }}
        />
        <CommentPanel
          open={isOpen}
          onClose={() => setIsOpen(false)}
          threads={comments.threads}
          loading={comments.loading}
          candidates={comments.candidates}
          currentUserId={currentUserId}
          canComment={canComment}
          canModerate={canModerate}
          isPlacing={placement.isPlacing}
          draftAnchor={placement.draftAnchor}
          onBeginPlacing={placement.beginPlacing}
          onCancelPlacing={placement.cancelPlacing}
          onClearDraftAnchor={placement.clearDraftAnchor}
          onUseSelectionAsAnchor={placement.useSelectionAsAnchor}
          hasSelection={hasSelection}
          onCreateThread={comments.createThread}
          onReply={comments.reply}
          onEdit={comments.edit}
          onDelete={comments.remove}
          onResolve={comments.resolve}
          onReopen={comments.reopen}
          activeThreadId={activeThreadId}
        />
      </div>,
      rootResult.value,
    );
  }, [
    adapter,
    comments,
    isOpen,
    placement,
    currentUserId,
    canComment,
    canModerate,
    hasSelection,
    activeThreadId,
  ]);

  return {
    commentsOverlay: overlay,
    isCommentsOpen: isOpen,
    toggleComments: toggleOpen,
    unresolvedCommentCount: comments.unresolvedCount,
    canComment,
  };
};
