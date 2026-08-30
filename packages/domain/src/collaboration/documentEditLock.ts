/**
 * Document edit lock's wire contract (NIL-637, Zweig B, collaboration
 * sockets domain): the three socket event names and the client-facing lock
 * shape, each declared independently on both sides
 * (`backend/src/server/socketDocumentEditLocks.ts`,
 * `frontend/src/pages/editor/documentEditLocks.ts`) with no comment
 * asserting they had to match.
 *
 * `PublicDocumentEditLock` is deliberately the narrow, client-facing shape
 * -- `assetId`/`presenceId`/`ownerName` only. The server's own internal
 * `DocumentEditLock` (`backend/src/server/documentEditLocks.ts`) also
 * carries `token` and `drawingId`; neither ever crosses the wire, per this
 * domain's standing rule: authority stays on the server, and a client
 * gets at most a stable reference (`presenceId`, `assetId`), never the
 * lock's own capability token.
 */

export const DOCUMENT_EDIT_LOCK_COMMAND_EVENT = "document-edit-lock-command";
export const DOCUMENT_EDIT_LOCK_EVENT = "document-edit-lock-update";
export const DOCUMENT_EDIT_LOCK_GRANTED_EVENT = "document-edit-lock-granted";

export type PublicDocumentEditLock = Readonly<{
  assetId: string;
  presenceId: string;
  ownerName: string;
}>;
