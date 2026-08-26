import type { Socket } from "socket.io-client";
import {
  collaborationEvents,
  drawingNameUpdateSchema,
  type DrawingNameUpdate,
} from "@excalidash/domain/collaboration";

const DRAWING_NAME_EVENT = collaborationEvents.drawingNameUpdate;
export type { DrawingNameUpdate } from "@excalidash/domain/collaboration";

export const parseDrawingNameUpdate = (
  value: unknown,
  drawingId: string,
): DrawingNameUpdate | null => {
  const parsed = drawingNameUpdateSchema.safeParse(value);
  if (!parsed.success || parsed.data.drawingId !== drawingId) return null;
  return parsed.data;
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
