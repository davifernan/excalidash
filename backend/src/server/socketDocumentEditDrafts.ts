import type { Socket } from "socket.io";
import { MAX_TEXT_UPLOAD_BYTES } from "../assets/textUpload";
import { DocumentEditLockRegistry } from "./documentEditLocks";
import { parseDrawingId } from "./socketProtocol";
import {
  registerAuthorizedRoomEvent,
  type RoomEventPayload,
  type RoomEventResult,
} from "./socketRoomEvent";

export const DOCUMENT_EDIT_DRAFT_COMMAND_EVENT = "document-edit-draft-command";
export const DOCUMENT_EDIT_DRAFT_EVENT = "document-edit-draft-update";
export const DOCUMENT_EDIT_DRAFT_LIMITS = { eventsPerSecond: 10 } as const;

const ASSET_ID = /^[\w-]{1,64}$/;
const TOKEN = /^[0-9a-f-]{36}$/i;
const MAX_PATCH_TEXT_BYTES = MAX_TEXT_UPLOAD_BYTES;

type DraftPatchCommand = RoomEventPayload & {
  action: "patch";
  assetId: string;
  token: string;
  revision: number;
  start: number;
  deleteCount: number;
  text: string;
};

type DraftClearCommand = RoomEventPayload & {
  action: "clear";
  assetId: string;
  token: string;
};

type DraftCommand = DraftPatchCommand | DraftClearCommand;

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export const parseDocumentEditDraftCommand = (value: unknown): DraftCommand | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  const assetId =
    typeof data.assetId === "string" && ASSET_ID.test(data.assetId) ? data.assetId : null;
  const token = typeof data.token === "string" && TOKEN.test(data.token) ? data.token : null;
  if (!drawingId || !assetId || !token) return null;
  if (data.action === "clear") return { drawingId, assetId, token, action: "clear" };
  if (
    data.action !== "patch" ||
    !nonNegativeInteger(data.start) ||
    !nonNegativeInteger(data.deleteCount) ||
    !nonNegativeInteger(data.revision) ||
    data.revision < 1 ||
    typeof data.text !== "string" ||
    Buffer.byteLength(data.text, "utf8") > MAX_PATCH_TEXT_BYTES
  ) {
    return null;
  }
  return {
    drawingId,
    assetId,
    token,
    action: "patch",
    revision: data.revision,
    start: data.start,
    deleteCount: data.deleteCount,
    text: data.text,
  };
};

export const documentEditDraftSnapshot = (locks: DocumentEditLockRegistry, drawingId: string) => ({
  drawingId,
  drafts: locks.draftSnapshot(drawingId),
});

export const registerDocumentEditDraftRoomEvent = ({
  socket,
  locks,
  requireAccess,
  allow,
}: {
  socket: Socket;
  locks: DocumentEditLockRegistry;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
  allow?: () => boolean;
}): void => {
  registerAuthorizedRoomEvent<DraftCommand>({
    socket,
    event: DOCUMENT_EDIT_DRAFT_COMMAND_EVENT,
    // The shared client publisher emits at most seven times per second. Ten
    // leaves room for the immediate cancel packet without permitting a
    // keystroke-frequency stream.
    limit: DOCUMENT_EDIT_DRAFT_LIMITS.eventsPerSecond,
    windowMs: 1_000,
    parse: parseDocumentEditDraftCommand,
    requireAccess,
    requireEdit: true,
    allow,
    rateLimitExempt: (value) =>
      Boolean(
        value && typeof value === "object" && (value as { action?: unknown }).action === "clear",
      ),
    handle: (command): RoomEventResult => {
      if (command.action === "clear") {
        if (!locks.clearDraft(command.drawingId, command.assetId, socket.id, command.token)) {
          return {
            error: {
              code: "document-edit-lock-lost",
              message: "The Markdown edit lock ended before its live draft could be cleared",
            },
          };
        }
        socket.to(`drawing_${command.drawingId}`).emit(DOCUMENT_EDIT_DRAFT_EVENT, {
          drawingId: command.drawingId,
          assetId: command.assetId,
          content: null,
        });
        return;
      }

      const draft = locks.applyDraftPatch({
        ...command,
        presenceId: socket.id,
        maxBytes: MAX_TEXT_UPLOAD_BYTES,
      });
      if (!draft) {
        return {
          error: {
            code: "document-edit-draft-out-of-sync",
            message: "The live Markdown draft is out of sync with its edit lock",
          },
        };
      }
      socket.to(`drawing_${command.drawingId}`).emit(DOCUMENT_EDIT_DRAFT_EVENT, {
        drawingId: command.drawingId,
        assetId: command.assetId,
        presenceId: socket.id,
        revision: command.revision,
        patch: {
          start: command.start,
          deleteCount: command.deleteCount,
          text: command.text,
        },
      });
    },
  });
};
