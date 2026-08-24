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
