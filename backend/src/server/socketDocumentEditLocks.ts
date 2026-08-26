import type { Server, Socket } from "socket.io";
import { collaborationEvents } from "@excalidash/domain/collaboration";
import { DocumentEditLockRegistry } from "./documentEditLocks";
import { parseDrawingId } from "./socketProtocol";
import {
  registerAuthorizedRoomEvent,
  type RoomEventPayload,
  type RoomEventResult,
} from "./socketRoomEvent";
import { logger } from "../logger";

export const DOCUMENT_EDIT_LOCK_COMMAND_EVENT = collaborationEvents.documentEditLockCommand;
export const DOCUMENT_EDIT_LOCK_EVENT = collaborationEvents.documentEditLockUpdate;
export const DOCUMENT_EDIT_LOCK_GRANTED_EVENT = collaborationEvents.documentEditLockGranted;

const ASSET_ID = /^[\w-]{1,64}$/;
const TOKEN = /^[0-9a-f-]{36}$/i;

type LockCommand = RoomEventPayload & {
  action: "acquire" | "release";
  assetId: string;
  token?: string;
};

const parseCommand = (value: unknown): LockCommand | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  const assetId =
    typeof data.assetId === "string" && ASSET_ID.test(data.assetId) ? data.assetId : null;
  if (!drawingId || !assetId || (data.action !== "acquire" && data.action !== "release")) {
    return null;
  }
  if (data.action === "release") {
    if (typeof data.token !== "string" || !TOKEN.test(data.token)) return null;
    return { drawingId, assetId, action: "release", token: data.token };
  }
  return { drawingId, assetId, action: "acquire" };
};

export const documentEditLockSnapshot = (locks: DocumentEditLockRegistry, drawingId: string) => ({
  drawingId,
  locks: locks.snapshot(drawingId),
});

export const registerDocumentEditLockRoomEvent = ({
  io,
  socket,
  prisma,
  locks,
  getPresence,
  requireAccess,
}: {
  io: Pick<Server, "to">;
  socket: Socket;
  prisma: any;
  locks: DocumentEditLockRegistry;
  getPresence: (socketId: string) => { presenceId: string; name: string } | null;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
}): void => {
  const roomName = (drawingId: string) => `drawing_${drawingId}`;
  const broadcast = (drawingId: string) =>
    io
      .to(roomName(drawingId))
      .emit(DOCUMENT_EDIT_LOCK_EVENT, documentEditLockSnapshot(locks, drawingId));

  registerAuthorizedRoomEvent<LockCommand>({
    socket,
    event: DOCUMENT_EDIT_LOCK_COMMAND_EVENT,
    limit: 60,
    windowMs: 60_000,
    parse: parseCommand,
    requireAccess,
    requireEdit: true,
    rateLimitExempt: (value) =>
      Boolean(
        value && typeof value === "object" && (value as { action?: unknown }).action === "release",
      ),
    handle: async (command): Promise<RoomEventResult> => {
      const presence = getPresence(socket.id);
      if (!presence) {
        return { error: { code: "not-in-room", message: "Document editing is not connected" } };
      }

      if (command.action === "release") {
        if (locks.release(command.drawingId, command.assetId, socket.id, command.token)) {
          broadcast(command.drawingId);
        }
        return;
      }

      const widget = await prisma.documentPageView.findFirst({
        where: {
          drawingId: command.drawingId,
          assetId: command.assetId,
          asset: { kind: "MARKDOWN", status: "READY" },
        },
        select: { elementId: true },
      });
      if (!widget) {
        const existing = await prisma.documentPageView.findMany({
          where: { drawingId: command.drawingId },
          select: { elementId: true, assetId: true },
        });
        logger.warn("NIL-601 diagnostic: markdown edit lock refused, asset not on board", {
          drawingId: command.drawingId,
          correlationId: socket.id,
          soughtAssetId: command.assetId,
          existingRows: existing,
        });
        return {
          error: {
            code: "document-not-editable",
            message: "This Markdown file is not on the board",
          },
        };
      }

      const acquired = locks.acquire({
        drawingId: command.drawingId,
        assetId: command.assetId,
        presenceId: socket.id,
        ownerName: presence.name,
      });
      if (!acquired.ok) {
        return {
          error: {
            code: "document-locked",
            message: `${acquired.lock.ownerName} is already editing this Markdown file`,
          },
        };
      }

      socket.emit(DOCUMENT_EDIT_LOCK_GRANTED_EVENT, {
        drawingId: command.drawingId,
        assetId: command.assetId,
        token: acquired.lock.token,
      });
      broadcast(command.drawingId);
    },
  });
};
