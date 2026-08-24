import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Inbox as InboxIcon, Rss } from "lucide-react";
import { Layout } from "../components/Layout";
import * as api from "../api";
import type { Collection } from "../types";
import type { ActivityEventDTO } from "../api/comments";
import { displayFontFamily } from "../utils/displayFont";
import { log } from "../logging";

/**
 * The team-wide Activity Feed, same reasoning and same shell-reuse pattern
 * as Inbox.tsx -- own route, unmodified `Layout`, not part of NIL-323's
 * Team Home rebuild in this wave.
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

const verbText: Record<string, string> = {
  "comment.created": "commented on",
  "comment.replied": "replied on",
  "comment.edited": "edited a comment on",
  "comment.deleted": "deleted a comment on",
  "comment.resolved": "resolved a thread on",
  "comment.reopened": "reopened a thread on",
};

// Matches the backend's own default (`activityRoutes.ts`'s `limit ?? "30"`).
const PAGE_SIZE = 30;

export const Activity: React.FC = () => {
  const navigate = useNavigate();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [events, setEvents] = useState<ActivityEventDTO[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    api
      .getCollections()
      .then(setCollections)
      .catch((err) => log.error("Failed to fetch collections", { error: err }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Read the previous "seen" marker before this visit overwrites it,
        // so today's own events don't retroactively stop looking new.
        const inbox = await api.getInbox({ unreadOnly: false });
        const { events: fetched } = await api.getTeamActivity();
        if (cancelled) return;
        setLastSeenAt(inbox.lastSeenAt);
        setEvents(fetched);
        setHasMore(fetched.length >= PAGE_SIZE);
      } finally {
        if (!cancelled) setLoading(false);
      }
      void api.visitActivityFeed();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = async () => {
    const oldest = events[events.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const { events: fetched } = await api.getTeamActivity({ before: oldest.createdAt });
      setEvents((prev) => [...prev, ...fetched]);
      setHasMore(fetched.length >= PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  };

  const openEvent = (event: ActivityEventDTO) => {
    navigate(
      event.threadRootId
        ? `/editor/${event.drawingId}?thread=${event.threadRootId}`
        : `/editor/${event.drawingId}`,
    );
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

  const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : null;

  return (
    <Layout
      collections={collections}
      selectedCollectionId="ACTIVITY"
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
          Activity
        </h1>
        <a
          href="/inbox"
          onClick={(event) => {
            event.preventDefault();
            navigate("/inbox");
          }}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm font-bold text-slate-700 dark:text-neutral-300 hover:bg-slate-50 dark:hover:bg-neutral-800"
        >
          <InboxIcon size={14} />
          Inbox
        </a>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-neutral-500 py-8 text-center">Loading...</p>
      ) : events.length === 0 ? (
        <div className="text-center py-16 text-slate-400 dark:text-neutral-600">
          <Rss size={32} className="mx-auto mb-2" />
          <p className="text-sm font-bold">No activity yet on the boards you belong to</p>
        </div>
      ) : (
        <div className="space-y-1.5" data-testid="activity-list">
          {events.map((event) => {
            const isNew = lastSeenMs !== null && new Date(event.createdAt).getTime() > lastSeenMs;
            return (
              <button
                key={event.id}
                type="button"
                onClick={() => openEvent(event)}
                data-testid="activity-event"
                data-event-id={event.id}
                data-new={isNew}
                className="w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-slate-50 dark:hover:bg-neutral-800/60 transition-colors"
              >
                {isNew ? (
                  <span
                    className="mt-1 text-[8px] font-black uppercase tracking-wide text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-600 rounded-full px-1.5 py-0.5 shrink-0"
                    data-testid="activity-new-badge"
                  >
                    New
                  </span>
                ) : null}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 dark:text-neutral-200">
                    <span className="font-black">{event.actorName}</span>{" "}
                    {verbText[event.verb] ?? "changed"}{" "}
                    <span className="font-bold">{event.drawingName}</span>
                  </p>
                  {event.summary ? (
                    <p className="text-xs text-slate-500 dark:text-neutral-400 mt-0.5 truncate">
                      &ldquo;{event.summary}&rdquo;
                    </p>
                  ) : null}
                  <p className="text-[10px] font-bold text-slate-400 dark:text-neutral-500 mt-1">
                    {timeAgo(event.createdAt)}
                  </p>
                </div>
              </button>
            );
          })}
          {hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              data-testid="activity-load-more"
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
