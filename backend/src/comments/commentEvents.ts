import type { Server } from "socket.io";
import { drawingCommentsRoomName } from "../server/socketRoomNames";
import {
  COMMENT_CREATED_EVENT,
  COMMENT_UPDATED_EVENT,
  COMMENT_DELETED_EVENT,
} from "@excalidash/domain/collaboration";
import type { CommentDTO } from "./commentsDomain";

export {
  COMMENT_CREATED_EVENT,
  COMMENT_UPDATED_EVENT,
  COMMENT_DELETED_EVENT,
} from "@excalidash/domain/collaboration";

/**
 * The three comment live-update broadcasts, pulled out of
 * `commentRoutes.ts` so the wire step (which event, which room) is
 * something a test can call directly instead of booting the whole Express
 * app to exercise a one-line `io.to(...).emit(...)` -- the same reason
 * every sibling collaboration domain (`socketDrawingName.ts`'s
 * `publishDrawingName`, `socketDocumentEditLocks.ts`'s
 * `documentEditLockSnapshot`) already keeps its own broadcast step as a
 * standalone function rather than inline in a route handler.
 */
export const publishCommentCreated = (
  io: Pick<Server, "to">,
  drawingId: string,
  comment: CommentDTO,
): void => {
  io.to(drawingCommentsRoomName(drawingId)).emit(COMMENT_CREATED_EVENT, comment);
};

export const publishCommentUpdated = (
  io: Pick<Server, "to">,
  drawingId: string,
  comment: CommentDTO,
): void => {
  io.to(drawingCommentsRoomName(drawingId)).emit(COMMENT_UPDATED_EVENT, comment);
};

export const publishCommentDeleted = (
  io: Pick<Server, "to">,
  drawingId: string,
  commentId: string,
): void => {
  io.to(drawingCommentsRoomName(drawingId)).emit(COMMENT_DELETED_EVENT, { id: commentId });
};
