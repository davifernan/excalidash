import {
  createViewportCapability,
  projectPoint,
  readViewport,
} from "../../integrations/excalidraw/viewport";
import type { Socket } from "socket.io-client";

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
    default:
      return "Follow mode ended on the server.";
  }
};

type ExcalidrawApi = {
  getAppState: () => any;
  updateScene: (scene: { appState: any }) => void;
  onScrollChange: (callback: () => void) => () => void;
  onUserFollow: (
    callback: (payload: {
      action: "FOLLOW" | "UNFOLLOW";
      userToFollow: { socketId: string };
    }) => void,
  ) => () => void;
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
const visibleBoundsOf = (api: Pick<ExcalidrawApi, "getAppState" | "updateScene">) => {
  const viewport = createViewportCapability(() => ({
    getAppState: api.getAppState,
    updateScene: api.updateScene as (change: Record<string, unknown>) => void,
    getSceneElements: () => [],
  }));
  const bounds = viewport.visibleBounds();
  return bounds.ok ? bounds.value : null;
};

export const fitFollowedBounds = (
  api: Pick<ExcalidrawApi, "getAppState" | "updateScene">,
  bounds: FollowSceneBounds,
) => {
  const viewport = createViewportCapability(() => ({
    getAppState: api.getAppState,
    updateScene: api.updateScene as (change: Record<string, unknown>) => void,
    getSceneElements: () => [],
  }));
  const applied = viewport.showBounds(bounds as never);
  if (!applied.ok) {
    return { appState: api.getAppState(), zoomClamped: false };
  }
  return {
    appState: api.getAppState(),
    zoomClamped: applied.value.zoomClamped,
  };
};

const createViewportIndicator = (container: HTMLDivElement | null) => {
  if (!container) return null;
  const frame = document.createElement("div");
  frame.dataset.followViewport = "frame";
  Object.assign(frame.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: "1",
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
    zIndex: "1",
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
    show(bounds: FollowSceneBounds, appState: any, zoomClamped: boolean) {
      // The viewport that was just computed, not necessarily the one on
      // screen: the indicator draws where the followed person is looking.
      const viewport = readViewport(appState);
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
  api,
  container,
  onFollowersChange,
  onFollowInterrupted,
}: {
  socket: Socket;
  drawingId: string;
  api: ExcalidrawApi;
  container: HTMLDivElement | null;
  onFollowersChange: (followers: Follower[]) => void;
  onFollowInterrupted?: (reason: string) => void;
}) => {
  let followers = new Map<string, Follower>();
  const lastViewportSequence = new Map<string, number>();
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
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
      sceneBounds: visibleBoundsOf(api),
    });
  };
  const scheduleBounds = () => {
    if (applyingIncomingBounds || sendTimer !== null || followers.size === 0) {
      return;
    }
    const visibleBounds = parseFollowSceneBounds(visibleBoundsOf(api));
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
    if (api.getAppState().userToFollow?.socketId !== lastReceivedPresenceId) return;
    applyingIncomingBounds = true;
    try {
      const fitted = fitFollowedBounds(api, lastReceivedBounds);
      lastAppliedVisibleBounds = parseFollowSceneBounds(visibleBoundsOf(api));
      viewportIndicator?.show(lastReceivedBounds, fitted.appState, fitted.zoomClamped);
    } finally {
      applyingIncomingBounds = false;
    }
  };

  const unsubscribeFollow = api.onUserFollow((payload) => {
    const targetPresenceId = payload.userToFollow?.socketId || null;
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
    socket.emit("follow-user", {
      drawingId,
      targetPresenceId: payload.userToFollow?.socketId,
      action: payload.action,
    });
  });
  const unsubscribeScroll = api.onScrollChange(scheduleBounds);

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
    api.updateScene({
      appState: { followedBy: new Set(next.keys()) },
    });
    if (followers.size > 0) sendBounds();
  };

  const onFollowStatus = (payload: any) => {
    if (payload?.drawingId !== drawingId) return;
    const targetPresenceId =
      typeof payload.followingPresenceId === "string" ? payload.followingPresenceId : null;
    const appState = api.getAppState();
    if (typeof payload.reason === "string") {
      onFollowInterrupted?.(payload.reason);
    }
    if (appState.userToFollow?.socketId === targetPresenceId) return;
    const previousTargetId = appState.userToFollow?.socketId || null;
    suppressServerFeedback(previousTargetId, targetPresenceId);
    lastViewportSequence.clear();
    if (!targetPresenceId) {
      lastReceivedBounds = null;
      lastReceivedPresenceId = null;
      lastAppliedVisibleBounds = null;
      viewportIndicator?.hide();
      if (appState.userToFollow) {
        api.updateScene({ appState: { userToFollow: null } });
      }
    } else {
      const collaborator = appState.collaborators?.get?.(targetPresenceId) || {};
      api.updateScene({
        appState: {
          userToFollow: { ...collaborator, socketId: targetPresenceId },
        },
      });
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
    const appState = api.getAppState();
    if (appState.userToFollow?.socketId !== payload.presenceId) return;
    if (appState.followedBy?.has?.(payload.presenceId)) return;
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
    if (suppressionTimer !== null) clearTimeout(suppressionTimer);
    suppressedServerActions = [];
    suppressionTimer = null;
    sendTimer = null;
    onFollowersChange([]);
    api.updateScene({ appState: { followedBy: new Set() } });
  };

  const cleanup = () => {
    unsubscribeFollow();
    unsubscribeScroll();
    socket.off("followed-by-update", onFollowedBy);
    socket.off("follow-status", onFollowStatus);
    socket.off("viewport-bounds", onViewportBounds);
    resizeObserver?.disconnect();
    if (sendTimer !== null) clearTimeout(sendTimer);
    if (suppressionTimer !== null) clearTimeout(suppressionTimer);
    viewportIndicator?.remove();
    onFollowersChange([]);
  };
  cleanup.resetConnectionState = resetConnectionState;
  return cleanup;
};
