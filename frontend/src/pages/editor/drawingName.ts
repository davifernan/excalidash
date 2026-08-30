import type { Socket } from "socket.io-client";
import {
  DRAWING_NAME_EVENT,
  MAX_DRAWING_NAME_LENGTH,
  type DrawingNameUpdate,
} from "@excalidash/domain/collaboration";

export { type DrawingNameUpdate } from "@excalidash/domain/collaboration";

export const parseDrawingNameUpdate = (
  value: unknown,
  drawingId: string,
): DrawingNameUpdate | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.drawingId !== drawingId || typeof data.name !== "string") return null;
  if (data.name.length === 0 || data.name.length > MAX_DRAWING_NAME_LENGTH) return null;
  if (
    typeof data.revision !== "number" ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 1
  ) {
    return null;
  }
  return { drawingId, name: data.name, revision: data.revision };
};

export const bindSocketDrawingName = ({
  socket,
  drawingId,
  onChange,
}: {
  socket: Socket;
  drawingId: string;
  onChange: (name: string) => void;
}) => {
  let latestRevision = 0;
  const onDrawingNameUpdate = (value: unknown) => {
    const update = parseDrawingNameUpdate(value, drawingId);
    if (update && update.revision > latestRevision) {
      latestRevision = update.revision;
      onChange(update.name);
    }
  };

  socket.on(DRAWING_NAME_EVENT, onDrawingNameUpdate);
  return {
    dispose() {
      socket.off(DRAWING_NAME_EVENT, onDrawingNameUpdate);
    },
  };
};
