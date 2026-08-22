import type { PrismaClient } from "../generated/client";
import type { Server } from "socket.io";

export const DRAWING_NAME_EVENT = "drawing-name-update";

export type DrawingNameUpdate = {
  drawingId: string;
  name: string;
  revision: number;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

const updatePayload = (drawingId: string, name: string, revision: number): DrawingNameUpdate => ({
  drawingId,
  name,
  revision,
});

export const publishDrawingName = ({
  io,
  drawingId,
  name,
  revision,
}: {
  io: Pick<Server, "to">;
  drawingId: string;
  name: string;
  revision: number;
}): boolean => {
  try {
    io.to(roomName(drawingId)).emit(DRAWING_NAME_EVENT, updatePayload(drawingId, name, revision));
    return true;
  } catch (error) {
    // Persistence already committed. A transient live-delivery failure must
    // not turn that successful write into a misleading HTTP failure.
    console.error("Drawing name broadcast failed after persistence:", error);
    return false;
  }
};

export const loadDrawingNameSnapshot = async ({
  prisma,
  drawingId,
}: {
  prisma: PrismaClient;
  drawingId: string;
}): Promise<DrawingNameUpdate | null> => {
  try {
    const drawing = await prisma.drawing.findUnique({
      where: { id: drawingId },
      select: { name: true, nameRevision: true },
    });
    return drawing ? updatePayload(drawingId, drawing.name, drawing.nameRevision) : null;
  } catch (error) {
    // Joining the collaboration room is still useful if this tiny snapshot is
    // temporarily unavailable; the normal drawing load already has a name.
    console.error("Drawing name snapshot failed while joining a board:", error);
    return null;
  }
};
