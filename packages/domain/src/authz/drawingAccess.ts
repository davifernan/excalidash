/**
 * The drawing access alphabet and its capability checks (NIL-637, Zweig B,
 * comments/authz domain, slice 6).
 *
 * `DrawingPermission`/`DrawingAccess` and the four capability predicates
 * below (`canViewDrawing`, `canCommentDrawing`, `canEditDrawing`,
 * `isOwnerAccess`) used to live only in `backend/src/authz/sharing.ts`. The
 * frontend never imported them: `frontend/src/pages/Editor.tsx` instead
 * hand-derived the same two checks --
 * `accessLevel === "edit" || accessLevel === "owner"` for canEdit,
 * `canEdit || accessLevel === "comment"` for canComment -- and at least
 * seven more frontend files (`DrawingCard.tsx`, `DrawingCardContextMenu.tsx`,
 * `useEditorSceneLoader.ts`, `chromeSlots.tsx`, `workshopTimerFeature.ts`,
 * `commentsFeature.ts`, `useCommentsFeature.tsx`) each re-typed the four
 * string literals as an anonymous union rather than importing a shared type.
 *
 * This is the same shape as NIL-624's pagination regression, not just a
 * type-alphabet nicety: `canCommentDrawing` is a real three-way rank check
 * (`"comment"` sits between viewing and editing, NIL-487), and a frontend
 * site that hand-derives "can this person edit" from `accessLevel` without
 * this predicate would silently miss a future access level added only on
 * the backend's side of the alphabet -- exactly the "byte-for-byte
 * equivalent" comment that stopped being true unnoticed.
 *
 * `getDrawingAccess` itself (the async lookup that resolves a principal +
 * drawingId to a `DrawingAccess`) stays backend-only: it needs Prisma and a
 * database round trip, and the frontend never computes access from scratch
 * -- it only ever receives an already-resolved `accessLevel` from an API
 * response and asks "what can I do with this value", which is exactly what
 * the four predicates below answer.
 */

export type DrawingPermission = "view" | "comment" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

export const ACCESS_RANK: Record<DrawingAccess, number> = {
  none: 0,
  view: 1,
  comment: 2,
  edit: 3,
  owner: 4,
};

export const canViewDrawing = (access: DrawingAccess): access is Exclude<DrawingAccess, "none"> =>
  access !== "none";

export const canEditDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "edit" | "owner"> => access === "edit" || access === "owner";

export const canCommentDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "comment" | "edit" | "owner"> =>
  access === "comment" || access === "edit" || access === "owner";

export const isOwnerAccess = (access: DrawingAccess): boolean => access === "owner";
