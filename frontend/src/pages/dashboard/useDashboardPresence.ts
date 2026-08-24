import { useEffect, useRef, useState } from "react";
import * as api from "../../api";

/** The server accepts no more; asking about more boards than fit a screen is
 * not a thing the dashboard needs to do. */
const MAX_WATCHED = 50;
const POLL_INTERVAL_MS = 10_000;

export type PresenceByDrawing = Map<string, { keys: ReadonlySet<string>; guestCount: number }>;

/**
 * The presence keys for one board, or `null` if the board isn't being
 * watched at all (untracked -- beyond `MAX_WATCHED`, or presence hasn't
 * loaded yet).
 *
 * `null` must stay distinct from an empty set: an empty set says "asked,
 * confirmed nobody online"; `null` says "don't know." Collapsing the two
 * makes a board past the watch limit render exactly like an empty board --
 * a silent truncation dressed up as a fact. `MemberAvatar` already treats
 * `null` as "no claim about presence" (`dimmed`/`online` both stay false).
 */
export const presenceKeysFor = (
  presence: PresenceByDrawing | null,
  drawingId: string,
): ReadonlySet<string> | null => {
  if (!presence) return null;
  const entry = presence.get(drawingId);
  return entry ? entry.keys : null;
};

/**
 * The guest count for one board, or `null` if the board isn't being watched
 * (same distinction as `presenceKeysFor`: an unwatched board is "don't know",
 * not "confirmed zero guests").
 */
export const guestCountFor = (
  presence: PresenceByDrawing | null,
  drawingId: string,
): number | null => {
  if (!presence) return null;
  const entry = presence.get(drawingId);
  return entry ? entry.guestCount : null;
};

/**
 * Whether a board is *confirmed* to have someone on it right now -- true
 * only when presence has actually answered for it with a non-empty result.
 * A board presence hasn't answered for yet (unknown) is `false` here, same
 * as a board confirmed empty -- this answers "should this count as open",
 * not "do we know". Shared by `CurrentlyOpenStrip` and the dashboard's
 * "Open now" filter (NIL-292/NIL-293) so both use exactly one definition of
 * "open".
 */
export const isConfirmedOpen = (presence: PresenceByDrawing | null, drawingId: string): boolean => {
  const keys = presenceKeysFor(presence, drawingId);
  const guests = guestCountFor(presence, drawingId);
  return (keys !== null && keys.size > 0) || (guests ?? 0) > 0;
};

/**
 * Who is on the boards currently listed.
 *
 * Polled rather than pushed: a dashboard does not need to know within a second,
 * and a socket subscription would need its own revocation, reconnect and
 * fan-out rules for an answer that is a few seconds fresher.
 */
export const useDashboardPresence = (drawingIds: readonly string[]): PresenceByDrawing | null => {
  const [presence, setPresence] = useState<PresenceByDrawing | null>(null);
  const watched = drawingIds.slice(0, MAX_WATCHED);
  // A stable key so the effect follows the set of boards, not the array identity.
  const watchKey = watched.join(",");
  const truncated = drawingIds.length > MAX_WATCHED;
  const warnedRef = useRef(false);

  useEffect(() => {
    // Once per mount: a scrolled-past-the-limit dashboard would otherwise
    // truncate silently, and the boards beyond the limit would render as if
    // confirmed empty instead of unwatched. See `presenceKeysFor`.
    if (truncated && !warnedRef.current) {
      warnedRef.current = true;
      console.warn(
        `useDashboardPresence: watching only the first ${MAX_WATCHED} of ${drawingIds.length} boards; presence for the rest is unknown, not "nobody online".`,
      );
    }
  }, [truncated, drawingIds.length]);

  useEffect(() => {
    const ids = watchKey ? watchKey.split(",") : [];
    if (ids.length === 0) {
      setPresence(null);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const results = await api.getDashboardPresence(ids);
        // A slow answer about a screen that has moved on is worse than no answer;
        // changing the watched set tears this effect down and sets the flag.
        if (cancelled) return;
        setPresence(
          new Map(
            results.map((result) => [
              result.drawingId,
              { keys: new Set(result.connectedMemberKeys), guestCount: result.guestCount },
            ]),
          ),
        );
      } catch {
        // Presence is decoration: a failed poll leaves the last answer standing
        // rather than blanking the page.
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [watchKey]);

  return presence;
};

export type CollectionPresence = { keys: ReadonlySet<string>; guestCount: number };

/**
 * Who from one collection is on any of its boards, right now -- the
 * collection-scoped sibling of `useDashboardPresence`. `null` while
 * unknown (no collection selected, or the first poll has not answered
 * yet), same null-vs-empty-set distinction as `presenceKeysFor`: a
 * `CollectionTeamBar` must not read "we haven't asked yet" as "confirmed
 * nobody online" (NIL-272).
 */
export const useCollectionPresence = (collectionId: string | undefined): CollectionPresence | null => {
  const [presence, setPresence] = useState<CollectionPresence | null>(null);

  useEffect(() => {
    // Switching collections must read as "unknown", not as the previous
    // collection's keys held over until the first poll for the new one
    // resolves -- a stale cross-collection Set is a worse lie than no
    // answer at all.
    setPresence(null);
    if (!collectionId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await api.getCollectionPresence(collectionId);
        if (cancelled) return;
        setPresence({ keys: new Set(result.connectedMemberKeys), guestCount: result.guestCount });
      } catch {
        // Presence is decoration here too: keep the last answer standing.
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [collectionId]);

  return presence;
};

/** subjectKey (team scope) -> the drawing id that member is currently on. */
export type TeamPresenceByMember = ReadonlyMap<string, string>;

/**
 * Which team members are on which of these boards, right now -- the
 * by-person sibling of `useDashboardPresence`'s by-board answer, for the
 * Sidebar's "Team" panel (NIL-294). `null` while unknown, same contract as
 * every other hook here: a `null` map must not be read as "nobody is
 * anywhere," only as "haven't asked yet."
 */
export const useTeamPresence = (drawingIds: readonly string[]): TeamPresenceByMember | null => {
  const [presence, setPresence] = useState<TeamPresenceByMember | null>(null);
  const watched = drawingIds.slice(0, MAX_WATCHED);
  const watchKey = watched.join(",");

  useEffect(() => {
    const ids = watchKey ? watchKey.split(",") : [];
    if (ids.length === 0) {
      setPresence(null);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const results = await api.getTeamPresence(ids);
        if (cancelled) return;
        setPresence(new Map(results.map((result) => [result.subjectKey, result.drawingId])));
      } catch {
        // Presence is decoration here too: keep the last answer standing.
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [watchKey]);

  return presence;
};
