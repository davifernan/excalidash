import type { Socket } from "socket.io";
import type { PresenceEntry } from "./presenceRegistry";
import {
  parseCursorPayload,
  parseDrawingId,
  parseElementUpdatePayload,
  elementUpdateLimitError,
  type ElementUpdatePayload,
} from "./socketProtocol";
import { registerAuthorizedRoomEvent, type RoomEventPayload } from "./socketRoomEvent";

type CoreRoomEventDeps = {
  socket: Socket;
  getPresence: (socketId: string) => PresenceEntry | null;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
  setActive: (drawingId: string, presenceId: string, isActive: boolean) => boolean;
  emitPresence: (drawingId: string) => void;
  /** Shared, keyed budget for activity pings; see registerAuthorizedRoomEvent. */
  allowActivity: () => boolean;
  /** Budgets shared across this person's connections; see socketRoomEvent. */
  allowCursorMove: () => boolean;
  allowElementUpdate: (drawingId: string, serializedBytes: number) => boolean;
};

type ActivityPayload = RoomEventPayload & { isActive: boolean };

const roomName = (drawingId: string) => `drawing_${drawingId}`;

const parseActivityPayload = (value: unknown): ActivityPayload | null => {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  return drawingId && typeof data.isActive === "boolean"
    ? { drawingId, isActive: data.isActive }
    : null;
};

export const registerCoreRoomEvents = ({
  socket,
  getPresence,
  requireAccess,
  setActive,
  emitPresence,
  allowActivity,
  allowCursorMove,
  allowElementUpdate,
}: CoreRoomEventDeps): void => {
  registerAuthorizedRoomEvent({
    socket,
    event: "cursor-move",
    limit: 40,
    windowMs: 1_000,
    parse: parseCursorPayload,
    requireAccess,
    allow: allowCursorMove,
    handle: (payload) => {
      const self = getPresence(socket.id);
      if (!self) return;
      socket.volatile.to(roomName(payload.drawingId)).emit("cursor-move", {
        drawingId: payload.drawingId,
        presenceId: socket.id,
        pointer: payload.pointer,
        button: payload.button,
        username: self.name,
        color: self.color,
      });
    },
  });

  registerAuthorizedRoomEvent<ElementUpdatePayload>({
    socket,
    event: "element-update",
    limit: 120,
    windowMs: 1_000,
    parse: parseElementUpdatePayload,
    parseLimitError: elementUpdateLimitError,
    requireAccess,
    allowPayload: (payload) => allowElementUpdate(payload.drawingId, payload.serializedBytes),
    requireEdit: true,
    handle: (payload) => {
      socket.to(roomName(payload.drawingId)).emit("element-update", {
        elements: payload.elements,
        files: payload.files,
        elementOrder: payload.elementOrder,
      });
      if (payload.elementOrderOmittedBytes) {
        return {
          warning: {
            code: "payload-too-large",
            message: `Element ordering was omitted because it uses ${payload.elementOrderOmittedBytes} bytes`,
          },
        };
      }
    },
  });

  registerAuthorizedRoomEvent({
    socket,
    event: "user-activity",
    limit: 20,
    windowMs: 10_000,
    allow: allowActivity,
    parse: parseActivityPayload,
    requireAccess,
    handle: (payload) => {
      if (setActive(payload.drawingId, socket.id, payload.isActive)) {
        emitPresence(payload.drawingId);
      }
    },
  });
};
