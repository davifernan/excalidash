import type { Server, Socket } from "socket.io";
import { collaborationEvents } from "@excalidash/domain/collaboration";
import { isOwnerAccess, type DrawingAccess } from "../authz/sharing";
import type { PresenceEntry } from "./presenceRegistry";
import { PresenterRegistry, type PresenterSnapshot } from "./presenterRegistry";
import { parseDrawingId, parseSceneBounds, type SceneBounds } from "./socketProtocol";
import { createRoomEventFeedback, type RoomEventAck } from "./socketRoomEvent";

export const PRESENTER_COMMAND_EVENT = collaborationEvents.presenterCommand;
export const PRESENTER_VIEWPORT_EVENT = collaborationEvents.presenterViewport;
export const PRESENTER_STATE_EVENT = collaborationEvents.presenterState;
export const PRESENTER_NOTES_EVENT = collaborationEvents.presenterNotes;
export const PRESENTER_NOTES_SET_EVENT = collaborationEvents.presenterNotesSet;

const MAX_FRAME_ID_LENGTH = 200;
const MAX_NOTES_LENGTH = 4_000;

const roomName = (drawingId: string) => `drawing_${drawingId}`;

type PresenterCommand = {
  readonly drawingId: string;
  readonly action: "start" | "stop" | "takeover";
};

const parsePresenterCommand = (value: unknown): PresenterCommand | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId) return null;
  if (data.action === "start" || data.action === "stop" || data.action === "takeover") {
    return { drawingId, action: data.action };
  }
  return null;
};

type PresenterViewportPayload = {
  readonly drawingId: string;
  readonly frameId: string | null;
  readonly sceneBounds: SceneBounds;
};

/** `undefined` means malformed; `null` is the valid "no frame" case. */
const parseFrameId = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.length > 0 && value.length <= MAX_FRAME_ID_LENGTH) {
    return value;
  }
  return undefined;
};

const parsePresenterViewport = (value: unknown): PresenterViewportPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  const sceneBounds = parseSceneBounds(data.sceneBounds);
  const frameId = parseFrameId(data.frameId);
  if (!drawingId || !sceneBounds || frameId === undefined) return null;
  return { drawingId, frameId, sceneBounds };
};

type NotesSetPayload = {
  readonly drawingId: string;
  readonly frameId: string | null;
  readonly text: string;
};

const parseNotesSetPayload = (value: unknown): NotesSetPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  const frameId = parseFrameId(data.frameId);
  if (!drawingId || frameId === undefined || typeof data.text !== "string") return null;
  if (data.text.length > MAX_NOTES_LENGTH) return null;
  return { drawingId, frameId, text: data.text };
};

type SocketPresenterManagerDeps = {
  io: Pick<Server, "to">;
  presenters: PresenterRegistry;
  getPresence: (socketId: string) => PresenceEntry | null;
  requireAccess: (
    socket: Socket,
    drawingId: string,
    requireEdit?: boolean,
  ) => Promise<DrawingAccess | null>;
};

/**
 * The presenter command surface.
 *
 * Deliberately not built on `registerAuthorizedRoomEvent`: that helper checks
 * access and discards both the socket and the resolved `DrawingAccess` before
 * calling `handle`, which is enough for a uniform view/edit gate but not for
 * "only the current presenter, or the owner" -- an authority question this
 * module answers per action, the same way `socketFollow.ts` does its own
 * inline `requireAccess` call rather than using the shared helper.
 */
export const createSocketPresenterManager = ({
  io,
  presenters,
  getPresence,
  requireAccess,
}: SocketPresenterManagerDeps) => {
  const emitState = (
    drawingId: string,
    snapshot: PresenterSnapshot,
    options?: { readonly volatile?: boolean },
  ) => {
    const recipients = io.to(roomName(drawingId));
    if (options?.volatile) recipients.volatile.emit(PRESENTER_STATE_EVENT, snapshot);
    else recipients.emit(PRESENTER_STATE_EVENT, snapshot);
  };

  const presenterName = (socketId: string): string => getPresence(socketId)?.name || "Presenter";

  /**
   * Pushed only to the presenter's own socket -- never a room broadcast.
   * Called after `start`/`takeover` (the notes for wherever presenting just
   * began, frame or none) and after every `advance` (the notes for the frame
   * just moved to), so the presenter's notes panel always shows the right
   * text without a separate request/response round trip.
   */
  const pushNotes = (socket: Socket, drawingId: string, frameId: string | null) => {
    socket.emit(PRESENTER_NOTES_EVENT, {
      drawingId,
      frameId,
      text: presenters.getNotes(drawingId, frameId),
    });
  };

  const registerHandlers = (
    socket: Socket,
    allowCommand: () => boolean,
    allowViewport: () => boolean,
  ) => {
    const commandFeedback = createRoomEventFeedback(socket, PRESENTER_COMMAND_EVENT, 60_000);
    const viewportFeedback = createRoomEventFeedback(socket, PRESENTER_VIEWPORT_EVENT, 1_000);

    socket.on(PRESENTER_COMMAND_EVENT, async (data: unknown, ack?: RoomEventAck) => {
      if (!allowCommand()) {
        commandFeedback.rateLimited(ack);
        return;
      }
      const parsed = parsePresenterCommand(data);
      if (!parsed) {
        commandFeedback.invalid(ack);
        return;
      }
      const { drawingId, action } = parsed;
      // Presenting is authored content for the whole room -- the same bar as
      // editing, not merely viewing (docs/product/WORKSHOP_PRESENTER.md,
      // "who may present").
      const access = await requireAccess(socket, drawingId, true);
      if (!access) {
        commandFeedback.rejected(
          { code: "access-denied", message: `${PRESENTER_COMMAND_EVENT} access denied` },
          ack,
        );
        return;
      }

      if (action === "takeover") {
        if (!isOwnerAccess(access)) {
          commandFeedback.rejected(
            { code: "forbidden", message: "Only the drawing owner can take over presenting" },
            ack,
          );
          return;
        }
        const result = presenters.start(drawingId, socket.id, presenterName(socket.id), {
          force: true,
        });
        if (result.status === "applied" && result.changed) emitState(drawingId, result.snapshot);
        if (result.status === "applied") pushNotes(socket, drawingId, result.snapshot.frameId);
        commandFeedback.succeeded(ack);
        return;
      }

      if (action === "start") {
        const result = presenters.start(drawingId, socket.id, presenterName(socket.id));
        if (result.status === "rejected") {
          commandFeedback.rejected(
            { code: result.reason, message: "Someone else is already presenting" },
            ack,
          );
          return;
        }
        if (result.changed) emitState(drawingId, result.snapshot);
        pushNotes(socket, drawingId, result.snapshot.frameId);
        commandFeedback.succeeded(ack);
        return;
      }

      // action === "stop"
      const result = presenters.stop(drawingId, socket.id, { force: isOwnerAccess(access) });
      if (result.status === "rejected") {
        commandFeedback.rejected({ code: result.reason, message: "You are not presenting" }, ack);
        return;
      }
      if (result.changed) emitState(drawingId, result.snapshot);
      commandFeedback.succeeded(ack);
    });

    // Fire-and-forget, like `viewport-bounds`: a stream of camera updates
    // has no business waiting on an ack round trip, and a rejected one needs
    // no user-facing error -- a deposed presenter's late pan is just not a
    // presenter's pan anymore.
    socket.on(PRESENTER_VIEWPORT_EVENT, async (data: unknown) => {
      if (!allowViewport()) {
        viewportFeedback.rateLimited();
        return;
      }
      const parsed = parsePresenterViewport(data);
      if (!parsed) {
        viewportFeedback.invalid();
        return;
      }
      const { drawingId, frameId, sceneBounds } = parsed;
      if (!(await requireAccess(socket, drawingId, true))) return;
      const result = presenters.advance(drawingId, socket.id, frameId, sceneBounds);
      if (result.status === "rejected") return;
      emitState(drawingId, result.snapshot, { volatile: frameId === null });
      pushNotes(socket, drawingId, frameId);
    });

    // Presenter Notes: readable and writable only by whoever currently holds
    // the presenter role for this drawing (docs/product/WORKSHOP_PRESENTER.md,
    // "who may read notes"). Never broadcast -- see the class comment on
    // PresenterRegistry's notes map.
    socket.on(PRESENTER_NOTES_SET_EVENT, async (data: unknown, ack?: RoomEventAck) => {
      if (!allowCommand()) {
        commandFeedback.rateLimited(ack);
        return;
      }
      const parsed = parseNotesSetPayload(data);
      if (!parsed) {
        commandFeedback.invalid(ack);
        return;
      }
      const { drawingId, frameId, text } = parsed;
      if (!(await requireAccess(socket, drawingId, true))) {
        commandFeedback.rejected(
          { code: "access-denied", message: `${PRESENTER_NOTES_SET_EVENT} access denied` },
          ack,
        );
        return;
      }
      if (!presenters.isPresenter(drawingId, socket.id)) {
        commandFeedback.rejected(
          { code: "not-presenting", message: "Only the current presenter can edit notes" },
          ack,
        );
        return;
      }
      presenters.setNotes(drawingId, frameId, text);
      commandFeedback.succeeded(ack);
    });
  };

  /** A presenter's socket left the drawing -- disconnect, revocation, board switch. */
  const clearSocket = (socketId: string, drawingId: string) => {
    const snapshot = presenters.clearSocket(drawingId, socketId);
    if (snapshot) emitState(drawingId, snapshot);
  };

  return { registerHandlers, clearSocket };
};

export type SocketPresenterManager = ReturnType<typeof createSocketPresenterManager>;
