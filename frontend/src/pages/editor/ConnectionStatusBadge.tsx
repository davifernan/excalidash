import { useEffect, useState, type FC } from "react";
import { createPortal } from "react-dom";
import type { ConnectionStatus } from "./useEditorCollaboration";
import "./ConnectionStatusBadge.css";

const RECONNECTING_DOT_INTERVAL_MS = 450;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const usePrefersReducedMotion = () => {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return reduced;
};

const useReconnectingDots = (status: ConnectionStatus) => {
  const reducedMotion = usePrefersReducedMotion();
  const [count, setCount] = useState(() => (reducedMotion ? 3 : 1));

  useEffect(() => {
    setCount(reducedMotion ? 3 : 1);
    if (status !== "reconnecting" || reducedMotion) return;

    const interval = window.setInterval(() => {
      setCount((current) => (current === 3 ? 1 : current + 1));
    }, RECONNECTING_DOT_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [reducedMotion, status]);

  return ".".repeat(count);
};

/**
 * A failure-only connection signal around the entire editor viewport.
 *
 * The healthy state deliberately has no visual or hit-testable chrome. Only
 * an empty, screen-reader-only live region stays mounted so the first failure
 * is announced as a text change. During an interruption, the continuous red
 * rectangle and attached text badge read as one global connection condition,
 * unlike NIL-590's separate triangular collaborator direction hints at
 * individual edge positions.
 *
 * The whole subtree is pointer-transparent. This is part of the component's
 * product contract, not merely a convenient default: an overlay at `inset: 0`
 * would otherwise make every underlying canvas and chrome control unreachable.
 */
export const ConnectionStatusBadge: FC<{
  container: HTMLElement | null;
  status: ConnectionStatus;
}> = ({ container, status }) => {
  const dots = useReconnectingDots(status);

  if (!container) return null;

  const reconnecting = status === "reconnecting";
  const label = status === "connected" ? "" : reconnecting ? "Reconnecting" : "Disconnected";

  return createPortal(
    <>
      {status === "connected" ? null : (
        <div
          className="connection-status-frame"
          data-status={status}
          data-testid="connection-status-frame"
        >
          <div
            className="connection-status-frame__badge"
            data-testid="connection-status-badge"
            aria-hidden="true"
          >
            <span>{label}</span>
            {reconnecting ? (
              <span
                className="connection-status-frame__dots"
                data-testid="connection-status-dots"
                aria-hidden="true"
              >
                {dots}
              </span>
            ) : null}
          </div>
        </div>
      )}
      {/* Mounted empty while healthy so the first failure changes an existing
          live region instead of inserting one with already-final text. */}
      <span
        className="sr-only"
        data-testid="connection-status-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {label}
      </span>
    </>,
    container,
  );
};
