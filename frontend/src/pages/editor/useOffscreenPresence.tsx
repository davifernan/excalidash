import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ExcalidrawAdapter } from "../../integrations/excalidraw/capabilities";
import { findFloatingToolbarObstacleElements } from "../../integrations/excalidraw/domBridge";
import type { FloatingToolbarObstacle } from "./floatingToolbarGeometry";
import {
  computeOffscreenMarkers,
  type OffscreenMarker,
  type OffscreenPeer,
} from "./offscreenPresenceGeometry";
import { OffscreenPresenceOverlay } from "./OffscreenPresenceOverlay";

/**
 * The adapter has no change event for a remote pointer (CollaborationCapability
 * has no `subscribe` -- see its file comment): socketCollaborators.ts patches
 * Excalidraw's own collaborator map directly, and Excalidraw renders the
 * on-screen cursors from that itself, outside React. This is the one thing
 * this feature needs that isn't already an event, so it polls instead of
 * growing the shared adapter contract for a single, cheap read (readCollaborators
 * over at most ten people). A scroll still recomputes immediately through
 * `subscribeScroll` so panning doesn't wait out the interval.
 */
const POLL_MS = 250;

export const useOffscreenPresence = ({
  adapter,
}: {
  adapter: ExcalidrawAdapter;
}): { offscreenPresenceOverlay: React.ReactNode } => {
  const [markers, setMarkers] = useState<readonly OffscreenMarker[]>([]);

  useEffect(() => {
    const recompute = () => {
      const viewportResult = adapter.viewport.read();
      const collaboratorsResult = adapter.collaboration.readCollaborators();
      if (!viewportResult.ok || !collaboratorsResult.ok) {
        setMarkers([]);
        return;
      }
      const size = { width: viewportResult.value.width, height: viewportResult.value.height };
      const peers: OffscreenPeer[] = [];
      for (const collaborator of collaboratorsResult.value) {
        if (collaborator.isSelf || !collaborator.pointer) continue;
        const projected = adapter.viewport.toViewport(collaborator.pointer);
        if (!projected.ok) continue;
        peers.push({
          id: String(collaborator.socketId),
          name: collaborator.name,
          color: collaborator.color,
          point: projected.value,
        });
      }
      setMarkers(computeOffscreenMarkers(peers, size, undefined, readObstacles()));
    };

    // The main toolbar (and, while one is open, the shape-actions panel) --
    // read fresh on every poll rather than cached, since either can appear,
    // move or disappear (zen mode, selection change) between ticks. Missing
    // the overlay root just means "no known obstacles this tick", not a
    // reason to stop showing markers.
    const readObstacles = (): FloatingToolbarObstacle[] => {
      const rootResult = adapter.ui.overlayRoot();
      if (!rootResult.ok) return [];
      const hostRect = rootResult.value.getBoundingClientRect();
      return findFloatingToolbarObstacleElements(rootResult.value).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left - hostRect.left,
          top: rect.top - hostRect.top,
          right: rect.right - hostRect.left,
          bottom: rect.bottom - hostRect.top,
        };
      });
    };

    recompute();
    const interval = setInterval(recompute, POLL_MS);
    const unsubscribeScroll = adapter.viewport.subscribeScroll(recompute);
    return () => {
      clearInterval(interval);
      unsubscribeScroll();
    };
  }, [adapter]);

  const rootResult = adapter.ui.overlayRoot();
  if (!rootResult.ok) return { offscreenPresenceOverlay: null };

  return {
    offscreenPresenceOverlay: createPortal(
      <OffscreenPresenceOverlay markers={markers} />,
      rootResult.value,
    ),
  };
};
