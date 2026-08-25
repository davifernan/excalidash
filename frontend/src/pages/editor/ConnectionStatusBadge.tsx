/**
 * A small, permanent, non-toast indicator of this connection's real state
 * (NIL-591).
 *
 * The state belongs in the chrome, not in a message: Davi flagged an
 * internal-throttling toast as disruptive the same day this ticket was
 * filed, and Miro's own documented popup-loop bug is the ticket's explicit
 * warning against repeated messages for something that is not an event but
 * a condition. A dot that is green while connected needs no attention and
 * asks for none; a toast that fires every reconnect asks for attention every
 * time, whether or not anything is actually wrong.
 *
 * The colour/shape encodes something true, the same way the workshop timer
 * pill turns white only while actually running (WorkshopTimerCorner.css) --
 * it is read off the same authoritative signal `useEditorCollaboration`
 * already computes (`onJoined` firing vs. `resetConnectionState` running vs.
 * `navigator.onLine`), not a separate guess.
 *
 * This is also directly what today's reconnect bug was missing: the
 * workshop timer played its sound again on reconnect because local state had
 * fallen to idle while the server's rejoin reply said "finished" -- a gap a
 * visible "reconnecting" state would have made legible to the user instead
 * of looking like the app spontaneously did something.
 *
 * Portalled into the Excalidraw root like WorkshopTimerCorner and the other
 * free-floating widgets, so it inherits colour tokens and
 * `--ui-pointerEvents` instead of drawing on top of them from a layer above.
 */
import type React from "react";
import { createPortal } from "react-dom";
import type { ConnectionStatus } from "./useEditorCollaboration";
import "./ConnectionStatusBadge.css";

const COPY: Record<ConnectionStatus, { label: string; description: string }> = {
  connected: { label: "Connected", description: "Live -- changes sync in real time." },
  reconnecting: {
    label: "Reconnecting",
    description: "Working on it -- your changes are saved locally and will sync once back.",
  },
  offline: {
    label: "Offline",
    description: "No network connection -- your changes are saved locally and will sync once back.",
  },
};

export const ConnectionStatusBadge: React.FC<{
  container: HTMLElement | null;
  status: ConnectionStatus;
}> = ({ container, status }) => {
  if (!container) return null;

  const copy = COPY[status];

  return createPortal(
    <div
      className="connection-status-badge"
      data-status={status}
      data-testid="connection-status-badge"
      title={`${copy.label} -- ${copy.description}`}
    >
      <span className="connection-status-badge__dot" aria-hidden="true" />
      {/* `display: none` by default (CSS) -- the dot alone carries the
          ambient signal on the canvas, shown as text on hover/focus for
          anyone who wants to check. Deliberately NOT the aria-live region
          below: a `display: none` element is removed from the accessibility
          tree along with the page, so it cannot double as the announcement. */}
      <span className="connection-status-badge__label" aria-hidden="true">
        {copy.label}
      </span>
      {/* Visually hidden, never `display: none` -- stays in the
          accessibility tree so a status change is announced without
          requiring a hover. */}
      <span className="sr-only" role="status" aria-live="polite">
        {copy.label}. {copy.description}
      </span>
    </div>,
    container,
  );
};
