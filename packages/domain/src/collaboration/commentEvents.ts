/**
 * Comment live-update socket event names (NIL-637, Zweig B, comments
 * domain): declared independently on both sides
 * (`backend/src/routes/dashboard/commentRoutes.ts`,
 * `frontend/src/pages/editor/comments/useComments.ts`) with no comment
 * asserting they had to match -- the same quiet duplication risk found in
 * every collaboration-sockets slice before this one.
 *
 * The payload itself (a full `CommentDTO`) is not part of this module:
 * that type lives in `backend/src/comments/commentsDomain.ts` and is
 * consumed by the frontend as a plain API/socket response shape, not
 * re-declared -- the risk this domain guards against is the event NAME
 * drifting, not the DTO shape (which has no independent second
 * declaration to drift from).
 */

export const COMMENT_CREATED_EVENT = "comment-created";
export const COMMENT_UPDATED_EVENT = "comment-updated";
export const COMMENT_DELETED_EVENT = "comment-deleted";
