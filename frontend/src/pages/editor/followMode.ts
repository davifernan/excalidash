import { createCollaborationCapability } from "../../integrations/excalidraw/collaboration";
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
/** What a given viewport can see, in scene coordinates. */
const visibleBoundsOfState = (appState: any) => {
  const viewport = createViewportCapability(() => ({
    getAppState: () => appState,
    updateScene: () => {},
    getSceneElements: () => [],
  }));
  const bounds = viewport.visibleBounds();
  return bounds.ok ? bounds.value : null;
};

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
  // Read through the capability, not the handle: this is the state before the
  // write, and it has to come from the same reading the capability uses.
  const read = viewport.read();
  const before = read.ok ? read.value : null;
  const applied = viewport.showBounds(bounds as never);
  if (!applied.ok || !before) {
    return { appState: {}, zoomClamped: false };
  }
  // The viewport the capability computed, merged over the state we read before
  // the write -- NOT a fresh getAppState(). Excalidraw's updateScene goes
  // through setState on a React 18 class component, so the state read straight
  // afterwards is still the pre-fit one. Reading it back would show the
  // follower's indicator at the old rectangle and, worse, store the old bounds
  // as "last applied", which defeats the echo guard: the next real scroll event
  // would not match, and the bounds just received would be sent back out.
  const { viewport: fitted } = applied.value;
  return {
    appState: {
      scrollX: fitted.scrollX,
      scrollY: fitted.scrollY,
      zoom: { value: fitted.zoom },
      width: fitted.width,
      height: fitted.height,
      offsetLeft: fitted.offsetLeft,
      offsetTop: fitted.offsetTop,
    },
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

/** The capabilities this feature needs, built once per binding. */
const capabilitiesFor = (api: ExcalidrawApi) => {
  const handle = () => ({
    getAppState: api.getAppState,
    updateScene: api.updateScene as (change: Record<string, unknown>) => void,
    getSceneElements: () => [],
    onScrollChange: api.onScrollChange,
    onUserFollow: api.onUserFollow,
  });
  return {
    viewport: createViewportCapability(handle),
    collaboration: createCollaborationCapability(handle),
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
  const { collaboration, viewport } = capabilitiesFor(api);
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
    const following = collaboration.readFollowState();
    if (!following.ok || following.value.followingSocketId !== lastReceivedPresenceId) return;
    applyingIncomingBounds = true;
    try {
      const fitted = fitFollowedBounds(api, lastReceivedBounds);
      lastAppliedVisibleBounds = parseFollowSceneBounds(visibleBoundsOfState(fitted.appState));
      viewportIndicator?.show(lastReceivedBounds, fitted.appState, fitted.zoomClamped);
    } finally {
      applyingIncomingBounds = false;
    }
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
    socket.emit("follow-user", {
      drawingId,
      targetPresenceId: payload.targetSocketId ?? undefined,
      action: payload.action,
    });
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
    if (suppressionTimer !== null) clearTimeout(suppressionTimer);
    suppressedServerActions = [];
    suppressionTimer = null;
    sendTimer = null;
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
