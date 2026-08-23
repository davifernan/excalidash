import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { Socket } from "socket.io-client";
import * as commentsApi from "../../../api/comments";
import type { CommentDTO, MentionCandidate } from "../../../api/comments";

export type ThreadDraftAnchor = { elementId: string | null; x: number; y: number };

type UseCommentsInput = {
  drawingId?: string;
  canComment: boolean;
  socketRef: MutableRefObject<Socket | null>;
  isReady: boolean;
};

export type Thread = { root: CommentDTO; replies: CommentDTO[] };

const groupThreads = (comments: CommentDTO[]): Thread[] => {
  const roots = comments.filter((c) => !c.rootId);
  const repliesByRoot = new Map<string, CommentDTO[]>();
  for (const comment of comments) {
    if (!comment.rootId) continue;
    const list = repliesByRoot.get(comment.rootId) ?? [];
    list.push(comment);
    repliesByRoot.set(comment.rootId, list);
  }
  return roots
    .map((root) => ({ root, replies: repliesByRoot.get(root.id) ?? [] }))
    .sort((a, b) => a.root.createdAt.localeCompare(b.root.createdAt));
};

export const useComments = ({ drawingId, canComment, socketRef, isReady }: UseCommentsInput) => {
  const [comments, setComments] = useState<CommentDTO[]>([]);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const drawingIdRef = useRef(drawingId);
  drawingIdRef.current = drawingId;

  const refresh = useCallback(async () => {
    if (!drawingId) return;
    setLoading(true);
    try {
      const { comments: fetched } = await commentsApi.getDrawingComments(drawingId, {
        includeResolved: true,
      });
      setComments(fetched);
    } finally {
      setLoading(false);
    }
  }, [drawingId]);

  useEffect(() => {
    if (!drawingId) return;
    void refresh();
  }, [drawingId, refresh]);

  useEffect(() => {
    if (!drawingId || !canComment) {
      setCandidates([]);
      return;
    }
    commentsApi
      .getMentionCandidates(drawingId)
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [drawingId, canComment]);

  // Live updates from whoever else is on the board -- the same socket
  // connection the editor already holds for collaboration, not a second one.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !isReady) return;
    const onCreated = (comment: CommentDTO) => {
      if (comment.drawingId !== drawingIdRef.current) return;
      setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
    };
    const onUpdated = (comment: CommentDTO) => {
      if (comment.drawingId !== drawingIdRef.current) return;
      setComments((prev) => prev.map((c) => (c.id === comment.id ? comment : c)));
    };
    const onDeleted = ({ id }: { id: string }) => {
      // Deletion is a tombstone server-side, not a removal -- refresh that one
      // row's real state instead of guessing it away locally.
      void refresh();
      void id;
    };
    socket.on("comment-created", onCreated);
    socket.on("comment-updated", onUpdated);
    socket.on("comment-deleted", onDeleted);
    return () => {
      socket.off("comment-created", onCreated);
      socket.off("comment-updated", onUpdated);
      socket.off("comment-deleted", onDeleted);
    };
  }, [socketRef, isReady, refresh]);

  const createThread = useCallback(
    async (body: string, anchor?: ThreadDraftAnchor | null) => {
      if (!drawingId) return;
      const comment = await commentsApi.createComment(drawingId, {
        body,
        elementId: anchor?.elementId ?? null,
        anchorX: anchor?.x,
        anchorY: anchor?.y,
      });
      setComments((prev) => [...prev, comment]);
      return comment;
    },
    [drawingId],
  );

  const reply = useCallback(
    async (rootId: string, body: string) => {
      if (!drawingId) return;
      const comment = await commentsApi.createComment(drawingId, { body, rootId });
      setComments((prev) => [...prev, comment]);
      return comment;
    },
    [drawingId],
  );

  const edit = useCallback(
    async (commentId: string, body: string) => {
      if (!drawingId) return;
      const comment = await commentsApi.editComment(drawingId, commentId, body);
      setComments((prev) => prev.map((c) => (c.id === commentId ? comment : c)));
    },
    [drawingId],
  );

  const remove = useCallback(
    async (commentId: string) => {
      if (!drawingId) return;
      await commentsApi.deleteComment(drawingId, commentId);
      await refresh();
    },
    [drawingId, refresh],
  );

  const resolve = useCallback(
    async (rootId: string) => {
      if (!drawingId) return;
      const comment = await commentsApi.resolveComment(drawingId, rootId);
      setComments((prev) => prev.map((c) => (c.id === rootId ? comment : c)));
    },
    [drawingId],
  );

  const reopen = useCallback(
    async (rootId: string) => {
      if (!drawingId) return;
      const comment = await commentsApi.reopenComment(drawingId, rootId);
      setComments((prev) => prev.map((c) => (c.id === rootId ? comment : c)));
    },
    [drawingId],
  );

  const threads = groupThreads(comments);
  const unresolvedCount = threads.filter((t) => !t.root.deletedAt && !t.root.resolvedAt).length;

  return {
    threads,
    loading,
    candidates,
    unresolvedCount,
    refresh,
    createThread,
    reply,
    edit,
    remove,
    resolve,
    reopen,
  };
};
