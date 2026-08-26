import type { Socket } from "socket.io";
import {
  REMOTE_SELECTION_PAYLOAD_BYTES,
  collaborationEvents,
} from "@excalidash/domain/collaboration";
import type { PresenceRegistry } from "./presenceRegistry";
import { parseDrawingId } from "./socketProtocol";
import { registerAuthorizedRoomEvent, type RoomEventPayload } from "./socketRoomEvent";

export const SELECTION_LIMITS = {
  // One transport budget accepts real imported ids without letting their format
  // silently decide how much of a selection survives.
  payloadBytes: REMOTE_SELECTION_PAYLOAD_BYTES,
  eventsPerSecond: 40,
} as const;

export const SELECTION_SNAPSHOT_EVENT = collaborationEvents.selectionSnapshot;

export type SelectionRoomPayload = RoomEventPayload &
  ({ selectedElementIds: string[] } | { allSelected: true });

export const parseSelectionPayload = (value: unknown): SelectionRoomPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId) return null;
  if (data.allSelected === true) {
    return data.selectedElementIds === undefined ? { drawingId, allSelected: true } : null;
  }
  if (!Array.isArray(data.selectedElementIds)) return null;

  let overBudget = false;
  let payloadBytes = Buffer.byteLength(JSON.stringify({ drawingId, selectedElementIds: [] }));
  for (const [index, id] of data.selectedElementIds.entries()) {
    if (typeof id !== "string" || id.length === 0) return null;
    if (overBudget) continue;
    payloadBytes += Buffer.byteLength(JSON.stringify(id)) + (index ? 1 : 0);
    overBudget = payloadBytes > SELECTION_LIMITS.payloadBytes;
  }
  return overBudget
    ? { drawingId, allSelected: true }
    : { drawingId, selectedElementIds: data.selectedElementIds as string[] };
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

export const registerSelectionRoomEvent = ({
  socket,
  presences,
  requireAccess,
  allow,
}: {
  socket: Socket;
  presences: PresenceRegistry;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
  /** Budget shared across this person's connections; see socketRoomEvent. */
  allow?: () => boolean;
}): void => {
  registerAuthorizedRoomEvent({
    socket,
    event: collaborationEvents.selectionUpdate,
    limit: SELECTION_LIMITS.eventsPerSecond,
    windowMs: 1_000,
    parse: parseSelectionPayload,
    requireAccess,
    allow,
    handle: (payload) => {
      const allSelected = "allSelected" in payload;
      const selectedElementIds = allSelected ? [] : payload.selectedElementIds;
      if (!presences.setSelection(payload.drawingId, socket.id, selectedElementIds, allSelected)) {
        return;
      }
      socket.to(roomName(payload.drawingId)).emit(collaborationEvents.selectionUpdate, {
        drawingId: payload.drawingId,
        presenceId: socket.id,
        ...(allSelected ? { allSelected: true } : { selectedElementIds }),
      });
    },
  });
};
