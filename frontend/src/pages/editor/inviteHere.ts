import type { Socket } from "socket.io-client";

import type { ViewportCapability } from "../../integrations/excalidraw/capabilities";
import type { SceneBounds } from "../../integrations/excalidraw/types";
import { parseFollowSceneBounds, type FollowSceneBounds } from "./followMode";

/**
 * How much two scene rectangles overlap, as intersection over union: 1 for
 * identical rectangles, 0 for rectangles that do not touch at all.
 *
 * Exported and unit-tested on its own because "already there" is a product
 * decision (NIL-372's "Feedback, wenn Ansichten bereits ähnlich sind") with a
 * threshold someone can reasonably want to move, not an implementation detail
 * worth hiding inside `respond`.
 */
export const boundsOverlap = (a: FollowSceneBounds, b: FollowSceneBounds): number => {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const intersection = (ix2 - ix1) * (iy2 - iy1);
  const areaOf = ([x1, y1, x2, y2]: FollowSceneBounds) => (x2 - x1) * (y2 - y1);
  const union = areaOf(a) + areaOf(b) - intersection;
  return union > 0 ? intersection / union : 0;
};

/**
 * High enough that a jump between two genuinely different parts of a large
 * board never counts as "the same place" merely because both views happen to
 * be zoomed out to a similar scale, low enough that ordinary pixel-level
 * differences in two people's own viewport (window size, a few frames of
 * scroll momentum) do not defeat the check it exists to make.
 */
const ALREADY_THERE_OVERLAP = 0.85;

export const isAlreadyThere = (own: FollowSceneBounds, target: FollowSceneBounds): boolean =>
  boundsOverlap(own, target) >= ALREADY_THERE_OVERLAP;

export type ViewportInvitation = {
  invitationId: string;
  inviterName: string;
  sceneBounds: FollowSceneBounds;
  expiresAt: number;
};

export type InviteHereStatus = {
  invitationId: string;
  arrivedCount: number;
  expiresAt: number;
};

/**
 * Invite Here needs two things from the editor: where this person is looking,
 * and the ability to put somebody else there. Both come from the viewport
 * capability now, so this file no longer knows what an app state is.
 */
type ViewportAccess = Pick<ViewportCapability, "visibleBounds" | "showBounds">;

const parseInvitation = (payload: any, drawingId: string): ViewportInvitation | null => {
  if (payload?.drawingId !== drawingId) return null;
  const sceneBounds = parseFollowSceneBounds(payload.sceneBounds);
  if (
    !sceneBounds ||
    typeof payload.invitationId !== "string" ||
    typeof payload.inviterName !== "string" ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= Date.now()
  ) {
    return null;
  }
  return {
    invitationId: payload.invitationId,
    inviterName: payload.inviterName,
    sceneBounds,
    expiresAt: payload.expiresAt,
  };
};

export const bindInviteHere = ({
  socket,
  drawingId,
  viewport,
  onInvitationChange,
  onStatusChange,
  onAlreadyThere,
}: {
  socket: Socket;
  drawingId: string;
  viewport: ViewportAccess;
  onInvitationChange: (invitation: ViewportInvitation | null) => void;
  onStatusChange: (status: InviteHereStatus | null) => void;
  /**
   * Accepted, but this browser's own view already overlaps the inviter's
   * closely enough that jumping would be indistinguishable from doing
   * nothing. Called instead of moving the viewport -- the accept itself
   * still counts, so the inviter's arrived-count still increments.
   */
  onAlreadyThere?: () => void;
}) => {
  let activeInvitation: ViewportInvitation | null = null;
  let invitationTimer: ReturnType<typeof setTimeout> | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  const clearInvitationTimer = () => {
    if (invitationTimer !== null) clearTimeout(invitationTimer);
    invitationTimer = null;
  };
  const clearStatusTimer = () => {
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = null;
  };
  const closeInvitation = () => {
    clearInvitationTimer();
    activeInvitation = null;
    onInvitationChange(null);
  };

  const onInvite = (payload: any) => {
    const invitation = parseInvitation(payload, drawingId);
    if (!invitation) return;
    clearInvitationTimer();
    clearStatusTimer();
    onStatusChange(null);
    activeInvitation = invitation;
    onInvitationChange(invitation);
    invitationTimer = setTimeout(
      () => {
        if (activeInvitation?.invitationId === invitation.invitationId) closeInvitation();
      },
      Math.max(0, invitation.expiresAt - Date.now()),
    );
  };

  const onStatus = (payload: any) => {
    if (
      payload?.drawingId !== drawingId ||
      typeof payload.invitationId !== "string" ||
      !Number.isSafeInteger(payload.arrivedCount) ||
      payload.arrivedCount < 0 ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now()
    ) {
      return;
    }
    clearStatusTimer();
    const status = {
      invitationId: payload.invitationId,
      arrivedCount: payload.arrivedCount,
      expiresAt: payload.expiresAt,
    };
    onStatusChange(status);
    statusTimer = setTimeout(
      () => onStatusChange(null),
      Math.max(0, status.expiresAt - Date.now()),
    );
  };

  const respond = (decision: "accepted" | "declined") => {
    const invitation = activeInvitation;
    if (!invitation || Date.now() >= invitation.expiresAt) return;
    closeInvitation();
    if (decision === "accepted") {
      const own = viewport.visibleBounds();
      const ownBounds = own.ok ? parseFollowSceneBounds(own.value) : null;
      if (ownBounds && isAlreadyThere(ownBounds, invitation.sceneBounds)) {
        onAlreadyThere?.();
      } else {
        viewport.showBounds(invitation.sceneBounds as SceneBounds);
      }
    }
    socket.emit("invite-here-response", {
      drawingId,
      invitationId: invitation.invitationId,
      decision,
    });
  };

  const reset = () => {
    clearInvitationTimer();
    clearStatusTimer();
    activeInvitation = null;
    onInvitationChange(null);
    onStatusChange(null);
  };

  socket.on("invite-here", onInvite);
  socket.on("invite-here-status", onStatus);
  return {
    invite() {
      const bounds = viewport.visibleBounds();
      // A failure here is already reported by the capability. Emitting an
      // invitation to nowhere would send everyone to the origin.
      if (bounds.ok) socket.emit("invite-here", { drawingId, sceneBounds: bounds.value });
    },
    accept: () => respond("accepted"),
    decline: () => respond("declined"),
    reset,
    dispose() {
      reset();
      socket.off("invite-here", onInvite);
      socket.off("invite-here-status", onStatus);
    },
  };
};
