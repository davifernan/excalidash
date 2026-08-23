import type { Socket } from "socket.io-client";

import type { ViewportCapability } from "../../integrations/excalidraw/capabilities";
import type { SceneBounds } from "../../integrations/excalidraw/types";
import { parseFollowSceneBounds, type FollowSceneBounds } from "./followMode";

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
}: {
  socket: Socket;
  drawingId: string;
  viewport: ViewportAccess;
  onInvitationChange: (invitation: ViewportInvitation | null) => void;
  onStatusChange: (status: InviteHereStatus | null) => void;
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
    if (decision === "accepted") viewport.showBounds(invitation.sceneBounds as SceneBounds);
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
