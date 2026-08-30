/**
 * Drawing name live-update's wire contract (NIL-637, Zweig B, collaboration
 * sockets domain, slice 1).
 *
 * `DRAWING_NAME_EVENT` and the `{ drawingId, name, revision }` shape were
 * declared once on each side (`backend/src/server/socketDrawingName.ts`,
 * `frontend/src/pages/editor/drawingName.ts`) with no comment even
 * asserting they had to match -- a quieter version of the NIL-624
 * pagination bug's "byte-for-byte equivalent" claim, since here nothing
 * claimed anything at all; the two sides simply happened to still agree.
 *
 * `MAX_DRAWING_NAME_LENGTH` is the sharper case: the frontend named it
 * explicitly, but the server's own limit was an unnamed `.max(255)` inside
 * a much larger zod schema in `backend/src/index.ts`, nowhere near
 * `socketDrawingName.ts` and disconnected from the socket contract this
 * module documents. A reader of either file alone had no way to discover
 * the other number existed, let alone that it had to match.
 */

export const DRAWING_NAME_EVENT = "drawing-name-update";

/** Matches the server's own limit on a drawing's persisted `name` field. */
export const MAX_DRAWING_NAME_LENGTH = 255;

export type DrawingNameUpdate = {
  drawingId: string;
  name: string;
  revision: number;
};
