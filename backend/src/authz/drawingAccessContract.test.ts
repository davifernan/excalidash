import { describe, expect, it } from "vitest";
import * as domain from "@excalidash/domain/authz";
import {
  ACCESS_RANK,
  canCommentDrawing,
  canEditDrawing,
  canViewDrawing,
  isOwnerAccess,
} from "./sharing";

/**
 * Identity proof for the drawing access contract's domain extraction
 * (NIL-637, comments/authz domain, slice 6): `sharing.ts` re-exports
 * `ACCESS_RANK` and the four capability predicates from
 * `@excalidash/domain/authz` rather than declaring its own copies. This
 * asserts they are the identical bindings by reference, not merely
 * behaviorally coincidental ones -- the same identity check every prior
 * NIL-637 slice ran for its own re-exported constants.
 *
 * The structural half of this slice's proof (no frontend file still
 * hand-declares the alphabet instead of importing it) lives in
 * `frontend/src/authzDrawingAccessDuplication.test.ts`, since that is a
 * frontend-tree scan and this package's vitest never touches
 * `frontend/src`.
 */
describe("drawing access contract identity", () => {
  it("sharing.ts re-exports the identical domain bindings, not re-declared copies", () => {
    expect(ACCESS_RANK).toBe(domain.ACCESS_RANK);
    expect(canViewDrawing).toBe(domain.canViewDrawing);
    expect(canEditDrawing).toBe(domain.canEditDrawing);
    expect(canCommentDrawing).toBe(domain.canCommentDrawing);
    expect(isOwnerAccess).toBe(domain.isOwnerAccess);
  });

  it.each([
    { access: "none" as const, view: false, comment: false, edit: false, owner: false },
    { access: "view" as const, view: true, comment: false, edit: false, owner: false },
    { access: "comment" as const, view: true, comment: true, edit: false, owner: false },
    { access: "edit" as const, view: true, comment: true, edit: true, owner: false },
    { access: "owner" as const, view: true, comment: true, edit: true, owner: true },
  ])("$access: rank and every predicate agree", ({ access, view, comment, edit, owner }) => {
    expect(canViewDrawing(access)).toBe(view);
    expect(canCommentDrawing(access)).toBe(comment);
    expect(canEditDrawing(access)).toBe(edit);
    expect(isOwnerAccess(access)).toBe(owner);
    // canCommentDrawing/canEditDrawing/isOwnerAccess must never grant more
    // than their own rank -- the exact regression NIL-487's design note
    // (see drawingAccess.ts) is there to prevent.
    if (edit) expect(ACCESS_RANK[access]).toBeGreaterThanOrEqual(ACCESS_RANK.edit);
    if (comment) expect(ACCESS_RANK[access]).toBeGreaterThanOrEqual(ACCESS_RANK.comment);
    if (owner) expect(ACCESS_RANK[access]).toBe(ACCESS_RANK.owner);
  });
});
