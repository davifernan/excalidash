/**
 * A collection share's grantable levels (NIL-637, comments/authz domain,
 * slice 7): declared independently on both sides
 * (`backend/src/authz/sharing.ts`, `frontend/src/types/index.ts`) with
 * identical literals and no import between them.
 *
 * Deliberately narrower than `DrawingPermission` (`"view" | "comment" |
 * "edit"`, see `drawingAccess.ts`): `"comment"` is a real board-level
 * permission, but nothing grants collection-level comment access yet -- no
 * UI offers it. Before `normalizeCollectionShareRole` existed, the two
 * collection-share routes validated with `normalizeDrawingPermission`
 * instead and so silently accepted `role: "comment"` despite their own
 * error messages claiming `view|edit` (NIL-502/NIL-489) -- the same
 * "alphabet accidentally wider than the contract says" shape as NIL-487.
 * `scripts/type-collision-inventory.cjs`'s BASELINE used to carry six
 * entries for this pair alongside `DrawingPermission`/`DrawingAccess`
 * (removed in the drawing-access slice, since one side of each pair moved
 * into this same domain package and the tool only tracks backend/frontend
 * declarations).
 */

export type CollectionShareRole = "view" | "edit";

export const normalizeCollectionShareRole = (input: unknown): CollectionShareRole | null => {
  if (input === "view" || input === "edit") return input;
  return null;
};
