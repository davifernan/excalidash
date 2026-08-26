import type { Socket } from "socket.io";
import { CURSOR_CHAT_MAX_LENGTH, collaborationEvents } from "@excalidash/domain/collaboration";
import { parseDrawingId } from "./socketProtocol";
import { registerAuthorizedRoomEvent, type RoomEventPayload } from "./socketRoomEvent";

/**
 * Cursor chat: a sentence that hangs off your pointer and then is gone.
 *
 * Nothing is stored, here or anywhere. That is the feature, not a shortcut --
 * a board chat accumulates unread messages and a duty to read them, and the
 * thing worth saying while pointing at a shape is almost never worth keeping.
 * What is worth keeping belongs in a comment, anchored to what it is about.
 *
 * View access is enough to speak. A visitor on a read-only link can still be in
 * the meeting, and refusing them a voice while they watch would be an odd kind
 * of politeness. The protections are a short cap, a rate limit, and the fact
 * that the sender's identity is the socket's, never the payload's.
 */
export const CURSOR_CHAT_LIMITS = {
  /** Long enough for a sentence, short enough that it cannot become an essay. */
  textLength: CURSOR_CHAT_MAX_LENGTH,
  eventsPerSecond: 10,
} as const;

export const CURSOR_CHAT_EVENT = collaborationEvents.cursorChat;

export type CursorChatPayload = RoomEventPayload & { text: string | null };

export const parseCursorChatPayload = (value: unknown): CursorChatPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId) return null;

  // null clears the bubble; anything else has to be a string within the cap.
  if (data.text === null) return { drawingId, text: null };
  if (typeof data.text !== "string") return null;
  if (data.text.length > CURSOR_CHAT_LIMITS.textLength) return null;
  // Control characters would let a sender break the line the bubble sits on.
  const text = data.text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return { drawingId, text: text.length ? text : null };
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

export const registerCursorChatRoomEvent = ({
  socket,
  requireAccess,
  allow,
}: {
  socket: Socket;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
  /** Budget shared across this person's connections; see socketRoomEvent. */
  allow?: () => boolean;
}): void => {
  registerAuthorizedRoomEvent({
    socket,
    event: CURSOR_CHAT_EVENT,
    limit: CURSOR_CHAT_LIMITS.eventsPerSecond,
    windowMs: 1_000,
    parse: parseCursorChatPayload,
    requireAccess,
    allow,
    handle: (payload) => {
      // Volatile: a bubble that arrives late is a bubble nobody wants.
      socket.volatile.to(roomName(payload.drawingId)).emit(CURSOR_CHAT_EVENT, {
        drawingId: payload.drawingId,
        // The sender is the socket, never whatever the payload claimed.
        presenceId: socket.id,
        text: payload.text,
      });
    },
  });
};
