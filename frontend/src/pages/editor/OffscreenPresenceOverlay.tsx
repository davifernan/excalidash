import type React from "react";
import type { OffscreenMarker } from "./offscreenPresenceGeometry";
import "./OffscreenPresenceOverlay.css";

/**
 * Pure rendering of already-computed markers (offscreenPresenceGeometry.ts).
 * No state, no polling -- useOffscreenPresence.tsx owns that and portals
 * this into `ui.overlayRoot()`, the same seam CommentMarkers.tsx uses.
 *
 * Deliberately not interactive: NIL-590 scopes out click-to-follow and an
 * avatar preview until the plain direction hint is shown to be not enough
 * on its own.
 */
export const OffscreenPresenceOverlay: React.FC<{ markers: readonly OffscreenMarker[] }> = ({
  markers,
}) => {
  if (markers.length === 0) return null;
  return (
    <div className="offscreen-presence" data-testid="offscreen-presence">
      {markers.map((marker) => {
        const label =
          marker.count === 1
            ? `${marker.names[0]} is off-screen`
            : `${marker.count} collaborators are off-screen: ${marker.names.join(", ")}`;
        return (
          <div
            key={marker.key}
            className="offscreen-presence__marker"
            style={{ left: marker.left, top: marker.top }}
            data-testid="offscreen-presence-marker"
          >
            <svg
              className="offscreen-presence__arrow"
              style={{
                transform: `rotate(${marker.angleDeg + 90}deg)`,
                ...(marker.color
                  ? ({ "--offscreen-presence-color": marker.color } as React.CSSProperties)
                  : {}),
              }}
              width="10"
              height="10"
              viewBox="0 0 10 10"
              role="img"
              aria-label={label}
            >
              <title>{label}</title>
              <path d="M5 0 L10 10 L5 7.5 L0 10 Z" />
            </svg>
            {marker.count > 1 ? (
              <span className="offscreen-presence__count" aria-hidden="true">
                {marker.count}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
