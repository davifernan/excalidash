/**
 * Presenter mode: client side.
 *
 * Follow with an authority on top (docs/product/COLLABORATION_NAVIGATION.md,
 * "What M4 can take over"), not a second presence concept -- there is no
 * per-viewer `follow-user` edge here. The server holds exactly one fact
 * ("who is presenting") and broadcasts it to the whole room; every socket
 * that receives it decides locally whether to move its own viewport.
 *
 * That local decision is `following` (default true): the audience's
 * deliberate "stop following" without leaving the room, the counterpart to
 * Follow's disconnect button. It never touches the server -- there is
 * nothing to tell it, the presenter keeps presenting to everyone else.
 */
import type { Socket } from "socket.io-client";
import {
  collaborationEvents,
  presenterNotesSchema,
  presenterSnapshotSchema,
  type CommandOutcome,
  type PresenterNotes,
  type PresenterSnapshot,
} from "@excalidash/domain/collaboration";
import type { ViewportCapability } from "../../integrations/excalidraw/capabilities";
import type { SceneBounds } from "../../integrations/excalidraw/types";

export const PRESENTER_COMMAND_EVENT = collaborationEvents.presenterCommand;
export const PRESENTER_VIEWPORT_EVENT = collaborationEvents.presenterViewport;
export const PRESENTER_STATE_EVENT = collaborationEvents.presenterState;
export const PRESENTER_NOTES_EVENT = collaborationEvents.presenterNotes;
export const PRESENTER_NOTES_SET_EVENT = collaborationEvents.presenterNotesSet;
export type {
  PresenterNotes,
  PresenterSnapshot,
  PresenterStatus,
} from "@excalidash/domain/collaboration";

export type PresenterCommandError = { readonly code: string; readonly message: string };
export type PresenterCommandOutcome = CommandOutcome;

export const createIdlePresenterSnapshot = (drawingId: string): PresenterSnapshot => ({
  drawingId,
  status: "idle",
  presenterPresenceId: null,
  presenterName: null,
  frameId: null,
  bounds: null,
  revision: 0,
});

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseBounds = (value: unknown): SceneBounds | null => {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber)) return null;
  return [value[0], value[1], value[2], value[3]] as SceneBounds;
};

export const parsePresenterSnapshot = (
  value: unknown,
  drawingId: string,
): PresenterSnapshot | null => {
  const parsed = presenterSnapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.drawingId !== drawingId) return null;
  if (data.status !== "idle" && data.status !== "presenting") return null;
  if (data.status === "idle") return createIdlePresenterSnapshot(drawingId);
  if (typeof data.presenterPresenceId !== "string") return null;
  const bounds = data.bounds == null ? null : parseBounds(data.bounds);
  if (data.bounds != null && !bounds) return null;
  return {
    drawingId,
    status: "presenting",
    presenterPresenceId: data.presenterPresenceId,
    presenterName: typeof data.presenterName === "string" ? data.presenterName : null,
    frameId: typeof data.frameId === "string" ? data.frameId : null,
    bounds,
    revision: isFiniteNumber(data.revision) ? data.revision : 0,
  };
};

const parsePresenterNotes = (value: unknown, drawingId: string): PresenterNotes | null => {
  const parsed = presenterNotesSchema.safeParse(value);
  if (!parsed.success || parsed.data.drawingId !== drawingId) return null;
  return { frameId: parsed.data.frameId, text: parsed.data.text };
};

const emitWithAck = (
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<PresenterCommandOutcome> =>
  new Promise((resolve) => {
    socket.emit(event, payload, (ack: unknown) => {
      const data = ack as { ok?: boolean; error?: PresenterCommandError } | undefined;
      if (data?.ok) resolve({ ok: true });
      else
        resolve({
          ok: false,
          error: data?.error ?? { code: "unknown", message: "Command failed" },
        });
    });
  });

type MinimalViewportApi = Pick<
  ViewportCapability,
  "visibleBounds" | "showBounds" | "subscribeScroll"
>;

export const bindPresenterMode = ({
  socket,
  drawingId,
  viewport,
  onStateChange,
  onNotesChange,
}: {
  socket: Socket;
  drawingId: string;
  viewport: MinimalViewportApi;
  onStateChange: (snapshot: PresenterSnapshot) => void;
  onNotesChange: (notes: PresenterNotes) => void;
}) => {
  let latest = createIdlePresenterSnapshot(drawingId);
  let following = true;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  // A jump to a named frame reports that frame once; every viewport change
  // after it (free panning, zooming) reports no frame until the next
  // deliberate jump -- see the file comment on PresenterRegistry.advance.
  let pendingFrameId: string | null = null;

  const isSelfPresenting = () =>
    latest.status === "presenting" && latest.presenterPresenceId === socket.id;

  const sendViewport = () => {
    sendTimer = null;
    if (!isSelfPresenting()) return;
    const bounds = viewport.visibleBounds();
    if (!bounds.ok) return;
    socket.emit(PRESENTER_VIEWPORT_EVENT, {
      drawingId,
      frameId: pendingFrameId,
      sceneBounds: bounds.value,
    });
    pendingFrameId = null;
  };
  const scheduleViewport = () => {
    if (sendTimer !== null) return;
    sendTimer = setTimeout(sendViewport, 50);
  };
  const unsubscribeScroll = viewport.subscribeScroll(() => {
    if (isSelfPresenting()) scheduleViewport();
  });

  const applyIncomingBounds = (snapshot: PresenterSnapshot) => {
    if (snapshot.status !== "presenting") return;
    if (snapshot.presenterPresenceId === socket.id) return; // never move for your own broadcast
    if (!following || !snapshot.bounds) return;
    viewport.showBounds(snapshot.bounds);
  };

  const onState = (value: unknown) => {
    const snapshot = parsePresenterSnapshot(value, drawingId);
    if (!snapshot) return;
    latest = snapshot;
    onStateChange(snapshot);
    applyIncomingBounds(snapshot);
  };
  const onNotes = (value: unknown) => {
    const notes = parsePresenterNotes(value, drawingId);
    if (notes) onNotesChange(notes);
  };
  socket.on(PRESENTER_STATE_EVENT, onState);
  socket.on(PRESENTER_NOTES_EVENT, onNotes);

  const reset = () => {
    latest = createIdlePresenterSnapshot(drawingId);
    onStateChange(latest);
    if (sendTimer !== null) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    pendingFrameId = null;
  };

  return {
    reset,
    dispose() {
      socket.off(PRESENTER_STATE_EVENT, onState);
      socket.off(PRESENTER_NOTES_EVENT, onNotes);
      unsubscribeScroll();
      if (sendTimer !== null) clearTimeout(sendTimer);
    },
    start: (): Promise<PresenterCommandOutcome> =>
      emitWithAck(socket, PRESENTER_COMMAND_EVENT, { drawingId, action: "start" }),
    stop: (): Promise<PresenterCommandOutcome> =>
      emitWithAck(socket, PRESENTER_COMMAND_EVENT, { drawingId, action: "stop" }),
    takeover: (): Promise<PresenterCommandOutcome> =>
      emitWithAck(socket, PRESENTER_COMMAND_EVENT, { drawingId, action: "takeover" }),
    /** The presenter clicked a frame in the navigator: report it once, now. */
    jumpToFrame(frameId: string, bounds: SceneBounds) {
      pendingFrameId = frameId;
      socket.emit(PRESENTER_VIEWPORT_EVENT, { drawingId, frameId, sceneBounds: bounds });
      pendingFrameId = null;
    },
    setNotes(frameId: string | null, text: string) {
      socket.emit(PRESENTER_NOTES_SET_EVENT, { drawingId, frameId, text });
    },
    /** The audience's own "follow / stop following" toggle. Local only. */
    setFollowing(next: boolean) {
      following = next;
    },
    isFollowing: () => following,
  };
};

export type PresenterModeController = ReturnType<typeof bindPresenterMode>;
