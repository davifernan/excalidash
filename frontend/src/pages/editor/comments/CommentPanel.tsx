import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  Crosshair,
  Inbox as InboxIcon,
  MapPin,
  MessageCircle,
  Pencil,
  Rss,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { CommentDTO, MentionCandidate } from "../../../api/comments";
import type { Thread } from "./useComments";
import type { ThreadDraftAnchor } from "./useComments";
import { MentionTextarea } from "./MentionTextarea";
import { splitMentionSegments } from "./mentionTokens";

type Filter = "open" | "resolved" | "all";

type Props = {
  open: boolean;
  onClose: () => void;
  threads: Thread[];
  loading: boolean;
  candidates: MentionCandidate[];
  currentUserId: string | null;
  canComment: boolean;
  canModerate: boolean;
  isPlacing: boolean;
  draftAnchor: ThreadDraftAnchor | null;
  onBeginPlacing: () => void;
  onCancelPlacing: () => void;
  onClearDraftAnchor: () => void;
  onUseSelectionAsAnchor: () => void;
  hasSelection: boolean;
  onCreateThread: (body: string, anchor: ThreadDraftAnchor | null) => Promise<unknown>;
  onReply: (rootId: string, body: string) => Promise<unknown>;
  onEdit: (commentId: string, body: string) => Promise<unknown>;
  onDelete: (commentId: string) => Promise<unknown>;
  onResolve: (rootId: string) => Promise<unknown>;
  onReopen: (rootId: string) => Promise<unknown>;
  activeThreadId: string | null;
};

const timeAgo = (iso: string): string => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

const CommentBody: React.FC<{ body: string | null }> = ({ body }) => {
  if (body === null) {
    return <p className="text-xs italic text-slate-400 dark:text-neutral-500">Comment deleted</p>;
  }
  return (
    <p className="text-xs font-medium text-slate-800 dark:text-neutral-200 whitespace-pre-wrap break-words">
      {splitMentionSegments(body).map((segment, index) =>
        segment.kind === "mention" ? (
          <span key={index} className="font-bold text-indigo-600 dark:text-indigo-400">
            @{segment.name}
          </span>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </p>
  );
};

const CommentRow: React.FC<{
  comment: CommentDTO;
  currentUserId: string | null;
  canModerate: boolean;
  onEdit: (commentId: string, body: string) => Promise<unknown>;
  onDelete: (commentId: string) => Promise<unknown>;
}> = ({ comment, currentUserId, canModerate, onEdit, onDelete }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body ?? "");
  const isOwn = comment.authorUserId === currentUserId;

  if (comment.deletedAt) {
    return (
      <div className="py-1.5">
        <CommentBody body={null} />
      </div>
    );
  }

  return (
    <div className="group py-1.5" data-testid="comment-row" data-comment-id={comment.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-black text-slate-900 dark:text-neutral-100">
          {comment.authorName}
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[9px] font-bold text-slate-400 dark:text-neutral-500">
            {timeAgo(comment.createdAt)}
            {comment.editedAt ? " (edited)" : ""}
          </span>
          {isOwn ? (
            <button
              type="button"
              onClick={() => setIsEditing((v) => !v)}
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-indigo-600"
              aria-label="Edit comment"
              data-testid="comment-edit-toggle"
            >
              <Pencil size={11} />
            </button>
          ) : null}
          {isOwn || canModerate ? (
            <button
              type="button"
              onClick={() => onDelete(comment.id)}
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600"
              aria-label="Delete comment"
              data-testid="comment-delete"
            >
              <Trash2 size={11} />
            </button>
          ) : null}
        </span>
      </div>
      {isEditing ? (
        <div className="mt-1 space-y-1">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-xs"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={async () => {
                await onEdit(comment.id, draft);
                setIsEditing(false);
              }}
              className="text-[10px] font-black text-indigo-600"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(comment.body ?? "");
                setIsEditing(false);
              }}
              className="text-[10px] font-black text-slate-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <CommentBody body={comment.body} />
      )}
    </div>
  );
};

const ThreadCard: React.FC<{
  thread: Thread;
  isActive: boolean;
  currentUserId: string | null;
  canComment: boolean;
  canModerate: boolean;
  candidates: MentionCandidate[];
  onReply: (rootId: string, body: string) => Promise<unknown>;
  onEdit: (commentId: string, body: string) => Promise<unknown>;
  onDelete: (commentId: string) => Promise<unknown>;
  onResolve: (rootId: string) => Promise<unknown>;
  onReopen: (rootId: string) => Promise<unknown>;
}> = ({
  thread,
  isActive,
  currentUserId,
  canComment,
  canModerate,
  candidates,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onReopen,
}) => {
  const [replyDraft, setReplyDraft] = useState("");
  const submitReply = async () => {
    const body = replyDraft.trim();
    if (!body) return;
    await onReply(thread.root.id, body);
    setReplyDraft("");
  };
  const isResolved = Boolean(thread.root.resolvedAt);

  return (
    <div
      data-testid="comment-thread"
      data-thread-id={thread.root.id}
      className={
        "rounded-xl border-2 px-3 py-2 " +
        (isActive
          ? "border-indigo-600 bg-indigo-50/60 dark:bg-indigo-900/10"
          : "border-black dark:border-neutral-700 bg-white dark:bg-neutral-900")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <CommentRow
            comment={thread.root}
            currentUserId={currentUserId}
            canModerate={canModerate}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
        {canComment ? (
          <button
            type="button"
            onClick={() => (isResolved ? onReopen(thread.root.id) : onResolve(thread.root.id))}
            title={isResolved ? "Reopen thread" : "Resolve thread"}
            aria-label={isResolved ? "Reopen thread" : "Resolve thread"}
            data-testid={isResolved ? "thread-reopen" : "thread-resolve"}
            className={
              "shrink-0 flex items-center justify-center w-6 h-6 rounded-lg border-2 " +
              (isResolved
                ? "border-slate-300 text-slate-400"
                : "border-emerald-600 text-emerald-600 hover:bg-emerald-50")
            }
          >
            <Check size={12} strokeWidth={3} />
          </button>
        ) : null}
      </div>
      {thread.replies.length > 0 ? (
        <div className="mt-1 ml-3 pl-2 border-l-2 border-slate-200 dark:border-neutral-800 space-y-0.5">
          {thread.replies.map((reply) => (
            <CommentRow
              key={reply.id}
              comment={reply}
              currentUserId={currentUserId}
              canModerate={canModerate}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}
      {canComment && !isResolved ? (
        <div className="mt-1.5 flex items-end gap-1.5">
          <div className="flex-1 min-w-0">
            <MentionTextarea
              value={replyDraft}
              onChange={setReplyDraft}
              candidates={candidates}
              rows={1}
              submitOnEnter
              placeholder="Reply... (@ to mention)"
              onSubmit={submitReply}
              data-testid="thread-reply-input"
            />
          </div>
          <button
            type="button"
            onClick={submitReply}
            disabled={!replyDraft.trim()}
            title="Send reply"
            aria-label="Send reply"
            data-testid="thread-reply-submit"
            className="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-600 text-white disabled:opacity-40"
          >
            <Send size={12} strokeWidth={2.5} />
          </button>
        </div>
      ) : null}
    </div>
  );
};

export const CommentPanel: React.FC<Props> = ({
  open,
  onClose,
  threads,
  loading,
  candidates,
  currentUserId,
  canComment,
  canModerate,
  isPlacing,
  draftAnchor,
  onBeginPlacing,
  onCancelPlacing,
  onClearDraftAnchor,
  onUseSelectionAsAnchor,
  hasSelection,
  onCreateThread,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onReopen,
  activeThreadId,
}) => {
  const [filter, setFilter] = useState<Filter>("open");
  const [newBody, setNewBody] = useState("");

  if (!open) return null;

  const filtered = threads.filter((t) => {
    if (t.root.deletedAt) return filter === "all";
    if (filter === "open") return !t.root.resolvedAt;
    if (filter === "resolved") return Boolean(t.root.resolvedAt);
    return true;
  });

  const submitNewThread = async () => {
    const body = newBody.trim();
    if (!body) return;
    await onCreateThread(body, draftAnchor);
    setNewBody("");
    onClearDraftAnchor();
  };

  return (
    <div
      data-testid="comment-panel"
      className="pointer-events-auto absolute top-14 right-2 bottom-2 w-[300px] flex flex-col rounded-2xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-950 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.08)] overflow-hidden"
      style={{ zIndex: 50 }}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b-2 border-black dark:border-neutral-700">
        <span className="text-xs font-black uppercase tracking-wide text-slate-900 dark:text-neutral-100">
          Comments
        </span>
        <div className="flex items-center gap-2">
          <Link
            to="/inbox"
            title="Inbox"
            aria-label="Inbox"
            data-testid="comment-panel-inbox-link"
            className="text-slate-400 hover:text-indigo-600"
          >
            <InboxIcon size={14} />
          </Link>
          <Link
            to="/activity"
            title="Activity"
            aria-label="Activity"
            data-testid="comment-panel-activity-link"
            className="text-slate-400 hover:text-indigo-600"
          >
            <Rss size={14} />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comments"
            data-testid="comment-panel-close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2">
        {(["open", "resolved", "all"] as Filter[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            data-testid={`comment-filter-${value}`}
            className={
              "px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wide border-2 " +
              (filter === value
                ? "border-indigo-600 text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20"
                : "border-transparent text-slate-400")
            }
          >
            {value}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {loading ? (
          <p className="text-[11px] text-slate-400 text-center py-6">Loading comments...</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-slate-400 dark:text-neutral-600">
            <MessageCircle size={22} className="mx-auto mb-1.5" />
            <p className="text-[11px] font-bold">
              {filter === "resolved" ? "No resolved threads" : "No comments yet"}
            </p>
          </div>
        ) : (
          filtered.map((thread) => (
            <ThreadCard
              key={thread.root.id}
              thread={thread}
              isActive={thread.root.id === activeThreadId}
              currentUserId={currentUserId}
              canComment={canComment}
              canModerate={canModerate}
              candidates={candidates}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onResolve={onResolve}
              onReopen={onReopen}
            />
          ))
        )}
      </div>

      {canComment ? (
        <div className="border-t-2 border-black dark:border-neutral-700 p-2.5 space-y-1.5">
          {draftAnchor ? (
            <div className="flex items-center justify-between text-[9px] font-bold text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 rounded-md px-2 py-1">
              <span className="flex items-center gap-1">
                <MapPin size={10} />
                {draftAnchor.elementId ? "Anchored to element" : "Anchored to point"}
              </span>
              <button type="button" onClick={onClearDraftAnchor} aria-label="Clear anchor">
                <X size={10} />
              </button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={isPlacing ? onCancelPlacing : onBeginPlacing}
                data-testid="comment-begin-placing"
                className={
                  "flex items-center gap-1 text-[9px] font-black uppercase px-2 py-1 rounded-md border-2 " +
                  (isPlacing
                    ? "border-indigo-600 text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20"
                    : "border-slate-300 dark:border-neutral-700 text-slate-500")
                }
              >
                <Crosshair size={10} />
                {isPlacing ? "Click the canvas..." : "Pin a point"}
              </button>
              {hasSelection ? (
                <button
                  type="button"
                  onClick={onUseSelectionAsAnchor}
                  data-testid="comment-use-selection"
                  className="flex items-center gap-1 text-[9px] font-black uppercase px-2 py-1 rounded-md border-2 border-slate-300 dark:border-neutral-700 text-slate-500"
                >
                  <MapPin size={10} />
                  Use selection
                </button>
              ) : null}
            </div>
          )}
          <MentionTextarea
            value={newBody}
            onChange={setNewBody}
            candidates={candidates}
            placeholder="Add a comment... (@ to mention)"
            onSubmit={submitNewThread}
            data-testid="new-comment-input"
          />
          <button
            type="button"
            onClick={submitNewThread}
            disabled={!newBody.trim()}
            data-testid="new-comment-submit"
            className="w-full text-[10px] font-black uppercase py-1.5 rounded-lg bg-indigo-600 text-white disabled:opacity-40"
          >
            Comment
          </button>
        </div>
      ) : (
        <div className="border-t-2 border-black dark:border-neutral-700 p-2.5 text-[10px] font-bold text-slate-400 text-center">
          You have view-only access to this board
        </div>
      )}
    </div>
  );
};
