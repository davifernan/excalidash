import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck, Inbox as InboxIcon, Rss } from "lucide-react";
import { Layout } from "../components/Layout";
import * as api from "../api";
import type { Collection } from "../types";
import type { NotificationDTO } from "../api/comments";
import { displayFontFamily } from "../utils/displayFont";
import { log } from "../logging";

/**
 * The Inbox has its own top-level route, deliberately not woven into
 * pages/Dashboard.tsx or components/Layout.tsx -- see the NIL-324 package
 * CLAIM. It reuses the unmodified `Layout` shell the same way Settings and
 * Profile already do, which is a different thing from editing it.
 */

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

const kindText: Record<string, string> = {
  mention: "mentioned you in",
  reply: "replied in",
  resolve: "resolved a thread in",
  reopen: "reopened a thread in",
};

// Matches the backend's own default (`inboxRoutes.ts`'s `limit ?? "30"") --
// a full page back is the signal there may be more; a short page is the
// signal there is not, without the backend needing to say so explicitly.
const PAGE_SIZE = 30;

export const Inbox: React.FC = () => {
  const navigate = useNavigate();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [notifications, setNotifications] = useState<NotificationDTO[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    api
      .getCollections()
      .then(setCollections)
      .catch((err) => log.error("Failed to fetch collections", { error: err }));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getInbox({ unreadOnly });
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
      setHasMore(data.notifications.length >= PAGE_SIZE);
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = async () => {
    const oldest = notifications[notifications.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await api.getInbox({ unreadOnly, before: oldest.createdAt });
      setNotifications((prev) => [...prev, ...data.notifications]);
      setHasMore(data.notifications.length >= PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  };

  const openNotification = async (notification: NotificationDTO) => {
    if (!notification.readAt) {
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notification.id ? { ...n, readAt: new Date().toISOString() } : n,
        ),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
      void api.markNotificationRead(notification.id);
    }
    const { drawingId, threadRootId } = notification.event;
    navigate(threadRootId ? `/editor/${drawingId}?thread=${threadRootId}` : `/editor/${drawingId}`);
  };

  const markAllRead = async () => {
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })),
    );
    setUnreadCount(0);
    await api.markAllNotificationsRead();
  };

  const handleCreateCollection = async (name: string) => {
    await api.createCollection(name);
    setCollections(await api.getCollections());
  };
  const handleEditCollection = async (id: string, name: string) => {
    setCollections((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
    await api.updateCollection(id, name);
  };
  const handleDeleteCollection = async (id: string) => {
    setCollections((prev) => prev.filter((c) => c.id !== id));
    await api.deleteCollection(id);
  };
  const handleSelectCollection = (id: string | null | undefined) => {
    if (id === undefined) navigate("/");
    else if (id === null) navigate("/collections?id=unorganized");
    else navigate(`/collections?id=${id}`);
  };

  return (
    <Layout
      collections={collections}
      selectedCollectionId="INBOX"
      onSelectCollection={handleSelectCollection}
      onCreateCollection={handleCreateCollection}
      onEditCollection={handleEditCollection}
      onDeleteCollection={handleDeleteCollection}
    >
      <div className="flex items-center justify-between mb-6 lg:mb-8">
        <h1
          className="text-3xl sm:text-4xl lg:text-5xl text-slate-900 dark:text-white pl-1"
          style={{ fontFamily: displayFontFamily }}
        >
          Inbox
        </h1>
        <div className="flex items-center gap-2">
          <a
            href="/activity"
            onClick={(event) => {
              event.preventDefault();
              navigate("/activity");
            }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm font-bold text-slate-700 dark:text-neutral-300 hover:bg-slate-50 dark:hover:bg-neutral-800"
          >
            <Rss size={14} />
            Activity
          </a>
          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={markAllRead}
              data-testid="inbox-mark-all-read"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm font-bold text-slate-700 dark:text-neutral-300 hover:bg-slate-50 dark:hover:bg-neutral-800"
            >
              <CheckCheck size={14} />
              Mark all read
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {[
          { value: false, label: "All" },
          { value: true, label: `Unread${unreadCount > 0 ? ` (${unreadCount})` : ""}` },
        ].map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => setUnreadOnly(option.value)}
            data-testid={`inbox-filter-${option.value ? "unread" : "all"}`}
            className={
              "px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-wide border-2 " +
              (unreadOnly === option.value
                ? "border-indigo-600 text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20"
                : "border-transparent text-slate-400")
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-neutral-500 py-8 text-center">Loading...</p>
      ) : notifications.length === 0 ? (
        <div className="text-center py-16 text-slate-400 dark:text-neutral-600">
          <InboxIcon size={32} className="mx-auto mb-2" />
          <p className="text-sm font-bold">
            {unreadOnly ? "No unread notifications" : "Nothing here yet"}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5" data-testid="inbox-list">
          {notifications.map((notification) => (
            <button
              key={notification.id}
              type="button"
              onClick={() => void openNotification(notification)}
              data-testid="inbox-notification"
              data-notification-id={notification.id}
              data-unread={!notification.readAt}
              className={
                "w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border-2 transition-colors " +
                (notification.readAt
                  ? "border-black dark:border-neutral-700 bg-white dark:bg-neutral-900"
                  : "border-indigo-600 bg-indigo-50/60 dark:bg-indigo-900/10")
              }
            >
              {!notification.readAt ? (
                <span
                  className="mt-1.5 w-2 h-2 rounded-full bg-indigo-600 shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <Bell size={14} className="mt-0.5 text-slate-300 dark:text-neutral-700 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 dark:text-neutral-200">
                  <span className="font-black">{notification.event.actorName}</span>{" "}
                  {kindText[notification.kind] ?? "posted in"}{" "}
                  <span className="font-bold">{notification.event.drawingName}</span>
                </p>
                {notification.event.summary ? (
                  <p className="text-xs text-slate-500 dark:text-neutral-400 mt-0.5 truncate">
                    &ldquo;{notification.event.summary}&rdquo;
                  </p>
                ) : null}
                <p className="text-[10px] font-bold text-slate-400 dark:text-neutral-500 mt-1">
                  {timeAgo(notification.createdAt)}
                </p>
              </div>
            </button>
          ))}
          {hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              data-testid="inbox-load-more"
              className="w-full mt-2 px-4 py-2.5 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 text-xs font-black uppercase tracking-wide text-slate-600 dark:text-neutral-300 hover:bg-slate-50 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </div>
      )}
    </Layout>
  );
};
