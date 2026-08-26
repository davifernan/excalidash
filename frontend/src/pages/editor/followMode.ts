import type {
  CollaborationCapability,
  ViewportCapability,
} from "../../integrations/excalidraw/capabilities";
import { projectPoint } from "../../integrations/excalidraw/viewport";
import type {
  AppliedViewport,
  SceneBounds,
  ViewportState,
} from "../../integrations/excalidraw/types";
import type { Socket } from "socket.io-client";
import { stacking } from "../../integrations/excalidraw/stacking";

/** Four scene coordinates: minX, minY, maxX, maxY. */
export type FollowSceneBounds = readonly [number, number, number, number];

export type Follower = {
  presenceId: string;
  name: string;
};

export const getFollowInterruptionMessage = (reason: string): string => {
  switch (reason) {
    case "disconnected":
      return "The person you were following disconnected. Follow mode ended.";
    case "target-unavailable":
      return "The person you were following is no longer available.";
    case "access-revoked":
      return "Follow mode ended because access changed.";
    case "rate-limited":
      return "Follow command was rate-limited; the server state was restored.";
    case "cycle-detected":
      return "You can't follow someone who is already following you.";
    case "self-follow":
      return "You can't follow yourself.";
    case "queue-full":
      return "Too many follow commands at once; try again in a moment.";
    default:
      return "Follow mode ended on the server.";
  }
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const parseFollowSceneBounds = (value: unknown): FollowSceneBounds | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every(isFiniteNumber)) return null;
  const [x1, y1, x2, y2] = value;
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2] as FollowSceneBounds;
};

/**
 * Show these bounds, and report what actually happened.
 *
 * Through the viewport capability: it applies the fit, hands back the viewport
 * that resulted, and says whether the zoom was clamped -- which it measures
 * before the fit, because afterwards the applied zoom is always inside the
 * limits and the clamp is invisible.
 */
/** What this person can currently see, in scene coordinates. */
const visibleBoundsOf = (viewport: ViewportCapability) => {
  const bounds = viewport.visibleBounds();
  return bounds.ok ? bounds.value : null;
};

export const fitFollowedBounds = (
  viewport: ViewportCapability,
  bounds: FollowSceneBounds,
): AppliedViewport | null => {
  const applied = viewport.showBounds(bounds as SceneBounds);
  return applied.ok ? applied.value : null;
};

const createViewportIndicator = (container: HTMLDivElement | null) => {
  if (!container) return null;
  const frame = document.createElement("div");
  frame.dataset.followViewport = "frame";
  Object.assign(frame.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: stacking.elementOverlay,
    border: "2px solid rgba(79, 70, 229, 0.9)",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.16)",
    boxSizing: "border-box",
    display: "none",
  });
  const warning = document.createElement("div");
  warning.dataset.followViewport = "zoom-warning";
  warning.textContent = "Target viewport exceeds the supported zoom range";
  Object.assign(warning.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: stacking.elementOverlay,
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "6px 10px",
    borderRadius: "6px",
    color: "white",
    background: "rgba(15, 23, 42, 0.78)",
    fontSize: "12px",
    display: "none",
  });
  container.append(frame, warning);

  return {
    show(bounds: FollowSceneBounds, viewport: ViewportState, zoomClamped: boolean) {
      // The viewport that was just computed, not necessarily the one on
      // screen: the indicator draws where the followed person is looking.
      const topLeft = projectPoint({ x: bounds[0], y: bounds[1] }, viewport);
      const bottomRight = projectPoint({ x: bounds[2], y: bounds[3] }, viewport);
      const containerRect = container.getBoundingClientRect();
      Object.assign(frame.style, {
        display: "block",
        left: `${topLeft.x - containerRect.left}px`,
        top: `${topLeft.y - containerRect.top}px`,
        width: `${bottomRight.x - topLeft.x}px`,
        height: `${bottomRight.y - topLeft.y}px`,
      });
      warning.style.display = zoomClamped ? "block" : "none";
    },
    hide() {
      frame.style.display = "none";
      warning.style.display = "none";
    },
    remove() {
      frame.remove();
      warning.remove();
    },
  };
};

export const bindFollowMode = ({
  socket,
  drawingId,
  collaboration,
  viewport,
  container,
  onFollowersChange,
  onFollowInterrupted,
}: {
  socket: Socket;
  drawingId: string;
  collaboration: CollaborationCapability;
  viewport: ViewportCapability;
  container: HTMLDivElement | null;
  onFollowersChange: (followers: Follower[]) => void;
  onFollowInterrupted?: (reason: string) => void;
}) => {
  let followers = new Map<string, Follower>();
  const lastViewportSequence = new Map<string, number>();
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingUnfollowTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressedServerActions: Array<{
    action: "FOLLOW" | "UNFOLLOW";
    targetPresenceId: string | null;
  }> = [];
  let suppressionTimer: ReturnType<typeof setTimeout> | null = null;
  let applyingIncomingBounds = false;
  let lastReceivedBounds: FollowSceneBounds | null = null;
  let lastReceivedPresenceId: string | null = null;
  let lastAppliedVisibleBounds: FollowSceneBounds | null = null;
  const viewportIndicator = createViewportIndicator(container);

  const suppressServerFeedback = (previousTargetId: string | null, nextTargetId: string | null) => {
    suppressedServerActions = [];
    if (previousTargetId && previousTargetId !== nextTargetId) {
      suppressedServerActions.push({
        action: "UNFOLLOW",
        targetPresenceId: previousTargetId,
      });
    }
    if (nextTargetId && previousTargetId !== nextTargetId) {
      suppressedServerActions.push({
        action: "FOLLOW",
        targetPresenceId: nextTargetId,
      });
    }
    if (suppressionTimer !== null) clearTimeout(suppressionTimer);
    suppressionTimer = setTimeout(() => {
      suppressedServerActions = [];
      suppressionTimer = null;
    }, 250);
  };

  const sendBounds = () => {
    sendTimer = null;
    if (followers.size === 0) return;
    socket.emit("viewport-bounds", {
      drawingId,
      sceneBounds: visibleBoundsOf(viewport),
    });
  };
  const scheduleBounds = () => {
    if (applyingIncomingBounds || sendTimer !== null || followers.size === 0) {
      return;
    }
    const visibleBounds = parseFollowSceneBounds(visibleBoundsOf(viewport));
    if (
      visibleBounds &&
      lastAppliedVisibleBounds &&
      visibleBounds.every(
        (value, index) => Math.abs(value - lastAppliedVisibleBounds![index]) < 0.0001,
      )
    ) {
      return;
    }
    lastAppliedVisibleBounds = null;
    sendTimer = setTimeout(sendBounds, 50);
  };

  const applyReceivedBounds = () => {
    if (!lastReceivedBounds || !lastReceivedPresenceId) return;
    const following = collaboration.readFollowState();
    if (!following.ok || following.value.followingSocketId !== lastReceivedPresenceId) return;
    applyingIncomingBounds = true;
    try {
      const fitted = fitFollowedBounds(viewport, lastReceivedBounds);
      if (!fitted) return;
      lastAppliedVisibleBounds = parseFollowSceneBounds(fitted.bounds);
      viewportIndicator?.show(lastReceivedBounds, fitted.viewport, fitted.zoomClamped);
    } finally {
      applyingIncomingBounds = false;
    }
  };

  const emitFollowCommand = (payload: { action: string; targetSocketId: string | null }) => {
    socket.emit("follow-user", {
      drawingId,
      targetPresenceId: payload.targetSocketId ?? undefined,
      action: payload.action,
    });
  };

  const unsubscribeFollow = collaboration.onFollowIntent((payload) => {
    const targetPresenceId = payload.targetSocketId;
    const suppressedIndex = suppressedServerActions.findIndex(
      (action) => action.action === payload.action && action.targetPresenceId === targetPresenceId,
    );
    if (suppressedIndex >= 0) {
      suppressedServerActions.splice(suppressedIndex, 1);
      if (suppressedServerActions.length === 0 && suppressionTimer !== null) {
        clearTimeout(suppressionTimer);
        suppressionTimer = null;
      }
      return;
    }
    lastViewportSequence.clear();
    lastReceivedBounds = null;
    lastReceivedPresenceId = null;
    lastAppliedVisibleBounds = null;
    viewportIndicator?.hide();
    if (payload.action === "UNFOLLOW") {
      // Excalidraw reports a target switch as UNFOLLOW(old) immediately
      // followed by FOLLOW(new). Coalesce that pair into the single FOLLOW
      // command the server already uses to replace its one target slot. A
      // genuine stop has no matching FOLLOW and is emitted next task.
      if (pendingUnfollowTimer !== null) clearTimeout(pendingUnfollowTimer);
      pendingUnfollowTimer = setTimeout(() => {
        pendingUnfollowTimer = null;
        emitFollowCommand(payload);
      }, 0);
      return;
    }
    if (pendingUnfollowTimer !== null) {
      clearTimeout(pendingUnfollowTimer);
      pendingUnfollowTimer = null;
    }
    emitFollowCommand(payload);
  });
  const unsubscribeScroll = viewport.subscribeScroll(scheduleBounds);

  const onFollowedBy = (payload: any) => {
    if (payload?.drawingId !== drawingId || !Array.isArray(payload.followers)) {
      return;
    }
    const next = new Map<string, Follower>();
    for (const follower of payload.followers) {
      if (typeof follower?.presenceId === "string" && typeof follower?.name === "string") {
        next.set(follower.presenceId, {
          presenceId: follower.presenceId,
          name: follower.name,
        });
      }
    }
    followers = next;
    onFollowersChange(Array.from(next.values()));
    collaboration.setFollowedBy([...next.keys()] as never);
    if (followers.size > 0) sendBounds();
  };

  const onFollowStatus = (payload: any) => {
    if (payload?.drawingId !== drawingId) return;
    const targetPresenceId =
      typeof payload.followingPresenceId === "string" ? payload.followingPresenceId : null;
    const state = collaboration.readFollowState();
    const currentTargetId = state.ok ? state.value.followingSocketId : null;
    if (typeof payload.reason === "string") {
      onFollowInterrupted?.(payload.reason);
    }
    if (currentTargetId === targetPresenceId) return;
    const previousTargetId = currentTargetId;
    suppressServerFeedback(previousTargetId, targetPresenceId);
    lastViewportSequence.clear();
    if (!targetPresenceId) {
      lastReceivedBounds = null;
      lastReceivedPresenceId = null;
      lastAppliedVisibleBounds = null;
      viewportIndicator?.hide();
      if (currentTargetId) {
        collaboration.follow(null);
      }
    } else {
      collaboration.follow(targetPresenceId as never);
    }
  };

  const onViewportBounds = (payload: any) => {
    if (payload?.drawingId !== drawingId) return;
    const bounds = parseFollowSceneBounds(payload.sceneBounds);
    if (!bounds || typeof payload.presenceId !== "string") return;
    if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return;
    if ((lastViewportSequence.get(payload.presenceId) || 0) >= payload.sequence) {
      return;
    }
    const state = collaboration.readFollowState();
    if (!state.ok) return;
    if (state.value.followingSocketId !== payload.presenceId) return;
    // Somebody following me does not get to move my view: that would be a loop
    // between two people each following the other.
    if (state.value.followedBySocketIds.includes(payload.presenceId as never)) return;
    lastViewportSequence.clear();
    lastViewportSequence.set(payload.presenceId, payload.sequence);
    lastReceivedBounds = bounds;
    lastReceivedPresenceId = payload.presenceId;
    applyReceivedBounds();
  };

  socket.on("followed-by-update", onFollowedBy);
  socket.on("follow-status", onFollowStatus);
  socket.on("viewport-bounds", onViewportBounds);
  const resizeObserver =
    container && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (lastReceivedBounds) applyReceivedBounds();
          scheduleBounds();
        })
      : null;
  if (container) resizeObserver?.observe(container);

  const resetConnectionState = () => {
    followers.clear();
    lastViewportSequence.clear();
    lastReceivedBounds = null;
    lastReceivedPresenceId = null;
    lastAppliedVisibleBounds = null;
    viewportIndicator?.hide();
    if (sendTimer !== null) clearTimeout(sendTimer);
    if (pendingUnfollowTimer !== null) clearTimeout(pendingUnfollowTimer);
    if (suppressionTimer !== null) clearTimeout(suppressionTimer);
    suppressedServerActions = [];
    suppressionTimer = null;
    sendTimer = null;
    pendingUnfollowTimer = null;
    onFollowersChange([]);
    collaboration.setFollowedBy([]);
  };

  const cleanup = () => {
    unsubscribeFollow();
    unsubscribeScroll();
    socket.off("followed-by-update", onFollowedBy);
    socket.off("follow-status", onFollowStatus);
    socket.off("viewport-bounds", onViewportBounds);
    resizeObserver?.disconnect();
    if (sendTimer !== null) clearTimeout(sendTimer);
    if (pendingUnfollowTimer !== null) clearTimeout(pendingUnfollowTimer);
    if (suppressionTimer !== null) clearTimeout(suppressionTimer);
    viewportIndicator?.remove();
    onFollowersChange([]);
  };
  cleanup.resetConnectionState = resetConnectionState;
  cleanup.follow = (targetPresenceId: string) => {
    // This is the same state transition Excalidraw's collaborator-avatar
    // click makes. Excalidraw reports it through onUserFollow, so the one
    // intent handler above remains the only path that clears stale viewport
    // state and sends the follow command to the server.
    collaboration.follow(targetPresenceId as never);
  };
  return cleanup;
};
