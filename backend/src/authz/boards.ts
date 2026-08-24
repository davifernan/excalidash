import type { Prisma } from "../generated/client";
import type { AuthzDb } from "./client";
import { getUserTrashCollectionId } from "../routes/dashboard/trash";

/**
 * Who owns a board, as a question rather than a column.
 *
 * `Drawing.userId` is the account that created the row. Today that is also who
 * owns the board, which is why routes read it directly and get away with it.
 * NIL-323 separates the two, and every direct read becomes wrong in the same
 * silent way: the query still runs, still returns rows, and returns the wrong
 * ones.
 *
 * The predicate lives here so that change is one edit. A route that says
 * `where: ownedBoardsWhere(userId)` follows it; a route that says
 * `where: { userId }` does not.
 */

/** The boards this account owns. */
export const ownedBoardsWhere = (userId: string): Prisma.DrawingWhereInput => ({ userId });

/** The collections this account owns. */
export const ownedCollectionsWhere = (userId: string): Prisma.CollectionWhereInput => ({ userId });

/**
 * Boards somebody else owns that this account holds a direct grant on.
 *
 * Both halves are one claim and belong together. `userId: { not: me }` is not a
 * detail of the listing -- it is what makes this "shared with me" rather than
 * "everything I can see", and some deployments keep an owner self-permission
 * row that would otherwise put your own boards in someone else's list.
 *
 * Split across a route and a relation filter, it was invisible to the boundary
 * check and to NIL-323 alike.
 */
export const boardsSharedWithWhere = (userId: string): Prisma.DrawingWhereInput => ({
  userId: { not: userId },
  permissions: { some: { granteeUserId: userId } },
});

/**
 * The viewer's own grant on each board, as a nested select.
 *
 * The route may name the field; it must not build the filter. Same rule as
 * everywhere else here: reaching the grant table is the contract's job, and a
 * select that carries `granteeUserId` is reaching it.
 */
export const grantedLevelSelect = (userId: string) => ({
  where: { granteeUserId: userId },
  select: { permission: true },
});

/**
 * The same claim one relation hop away.
 *
 * Snapshots and drawing-assets have no owner of their own; they belong to
 * whoever owns the board. Export filtered them with `{ drawing: { userId } }`
 * inline, which is the ownership rule written a third time in a third file.
 */
export const throughOwnedBoardWhere = (userId: string) => ({ drawing: ownedBoardsWhere(userId) });

/**
 * The board, but only if this account owns it.
 *
 * Null covers both "no such board" and "not yours", and callers must not tell
 * them apart -- the difference is exactly the information a probe wants.
 */
export const getOwnedBoard = async (params: { db: AuthzDb; userId: string; boardId: string }) =>
  params.db.drawing.findFirst({
    where: { id: params.boardId, ...ownedBoardsWhere(params.userId) },
  });

/** Delete the board, but only if this account still owns it. Count of rows removed. */
export const deleteOwnedBoard = async (params: {
  db: AuthzDb;
  userId: string;
  boardId: string;
}): Promise<number> =>
  (
    await params.db.drawing.deleteMany({
      where: { id: params.boardId, ...ownedBoardsWhere(params.userId) },
    })
  ).count;

/**
 * Does a board with this id exist, and does this account own it?
 *
 * Import needs all three answers -- absent, mine, someone else's -- and reading
 * `existing.userId !== req.user.id` collapses the first two. An id that belongs
 * to another account must be re-keyed rather than overwritten, so getting this
 * wrong writes one account's board over another's.
 */
export type BoardClaim = "absent" | "owned" | "foreign";

export const claimOnBoard = async (params: {
  db: AuthzDb;
  userId: string;
  boardId: string;
}): Promise<BoardClaim> => {
  const existing = await params.db.drawing.findUnique({
    where: { id: params.boardId },
    select: { userId: true },
  });
  if (!existing) return "absent";
  return existing.userId === params.userId ? "owned" : "foreign";
};

/** The same three answers for a collection. */
export const claimOnCollection = async (params: {
  db: AuthzDb;
  userId: string;
  collectionId: string;
}): Promise<BoardClaim> => {
  const existing = await params.db.collection.findUnique({
    where: { id: params.collectionId },
    select: { userId: true },
  });
  if (!existing) return "absent";
  return existing.userId === params.userId ? "owned" : "foreign";
};

/**
 * The row-creator claim, for callers that already loaded the board.
 *
 * Deliberately NOT `isOwnerAccess`. A collection's owner has owner *access* to
 * every board inside it without having drawn any of them, and the two answers
 * are used for different things: control decides who may share a board,
 * while this one decides what a response is allowed to disclose about it.
 *
 * drawingReadRoutes gates the creator's account id and the collection id on
 * this. Widening it to owner access would hand a collection owner the account
 * id of everyone who ever drew in their collection -- a product decision that
 * belongs to NIL-323's ownership rework, not to a boundary migration.
 */
export const isBoardCreator = (
  board: { userId: string },
  userId: string | null | undefined,
): boolean => !!userId && board.userId === userId;

/**
 * The same narrow claim for a collection.
 *
 * Named separately from isBoardCreator rather than sharing one structural
 * helper: the two rows carry the same column and answer different questions,
 * and NIL-323 may well move only one of them.
 */
export const isCollectionCreator = (
  collection: { userId: string },
  userId: string | null | undefined,
): boolean => !!userId && collection.userId === userId;

/**
 * Hand every board this account owns to a successor.
 *
 * Offboarding, and one of two places ownership changes in bulk (the other is
 * `transferOwnedCollections`, just below). It is here rather than in the
 * offboarding routine because it is the same claim NIL-323 redefines: after
 * that rework, "the boards this account owns" is no longer a column match,
 * and a transfer written as one would silently move the wrong set -- or none.
 *
 * `detachFromCollection` defaults to `true`: full account deletion
 * (`userOffboarding.ts`) cascades away the departing account's collections in
 * the same transaction, so a board left pointing at a collection about to
 * disappear would dangle. Plain deactivation does not delete the account or
 * its collections -- `transferOwnedCollections` moves those instead -- so
 * that caller passes `false` and boards keep their place in the (now
 * reassigned) collection.
 *
 * `excludeTrash` defaults to `false` for callers that have their own
 * (equally deliberate) reason not to filter -- there is none in this
 * codebase today; every production caller passes `true` (both
 * `userOffboarding.ts`'s full deletion and `adminUserRoutes.ts`'s plain
 * deactivation, NIL-300/NIL-341). A board's `trash:<userId>` collection id
 * is scoped to the account that trashed it (`routes/dashboard/trash.ts`),
 * not to whoever later comes to own the board. Reassigning a trashed
 * board's ownership without excluding it would resurface it in the new
 * owner's "All Drawings" -- that listing's trash exclusion matches only the
 * *requester's own* trash id (`drawingListRoutes.ts`), so a board still
 * carrying someone else's trash id reads as a live, organized board again.
 *
 * Returns how many boards moved.
 */
export const transferOwnedBoards = async (params: {
  db: AuthzDb;
  fromUserId: string;
  toUserId: string;
  detachFromCollection?: boolean;
  excludeTrash?: boolean;
}): Promise<number> =>
  (
    await params.db.drawing.updateMany({
      where: {
        ...ownedBoardsWhere(params.fromUserId),
        // Prisma's `not` on a nullable column excludes NULL rows too (SQL's
        // three-valued `<>` logic) -- an unorganized board would otherwise
        // silently stop being reassigned. Verified empirically against both
        // sqlite and this exact filter before relying on it.
        ...(params.excludeTrash
          ? {
              OR: [
                { collectionId: null },
                { collectionId: { not: getUserTrashCollectionId(params.fromUserId) } },
              ],
            }
          : {}),
      },
      data: {
        userId: params.toUserId,
        ...(params.detachFromCollection === false ? {} : { collectionId: null }),
      },
    })
  ).count;

/**
 * Hand every collection this account owns to a successor, boards and all --
 * except the account's own trash.
 *
 * A collection is organization, not a grant: moving who administers it does
 * not change who owns the boards inside, so unlike `transferOwnedBoards` this
 * never touches `Drawing.userId`. Used when a member leaves (deactivation)
 * so their folders keep an administrator instead of becoming permanently
 * unmanageable -- nobody could rename, delete, or reshare them, since only
 * the (now inactive) owner and `authz/collections.ts` decide that.
 *
 * `ownedCollectionsWhere` matches every collection by `userId`, including
 * the departing account's `trash:<userId>` row (`routes/dashboard/trash.ts`)
 * -- that id is only ever recognized as "the" trash collection for its own
 * account (`GET /collections` remaps it to the public id `"trash"` solely
 * for the requester it belongs to). Transferred as-is, it stops being
 * anyone's trash and starts being a plain, visible collection literally
 * named "Trash" in the new owner's list and "move to" menus, holding
 * whatever the departing member had already deleted. Excluded here instead.
 *
 * Returns how many collections moved.
 */
export const transferOwnedCollections = async (params: {
  db: AuthzDb;
  fromUserId: string;
  toUserId: string;
}): Promise<number> =>
  (
    await params.db.collection.updateMany({
      where: {
        ...ownedCollectionsWhere(params.fromUserId),
        id: { not: getUserTrashCollectionId(params.fromUserId) },
      },
      data: { userId: params.toUserId },
    })
  ).count;

/**
 * Move this account's boards out of the shared legacy "trash" bucket.
 *
 * Early versions stored every deleted board under the literal collection id
 * "trash", which is one bucket for the whole instance. The per-account trash
 * replaced it, and this reunites the leftovers with their owner -- so it is a
 * board-ownership decision even though it reads like a data fix, and it belongs
 * behind the same boundary as the rest.
 */
export const adoptLegacyTrashBoards = async (params: {
  db: AuthzDb;
  userId: string;
  trashCollectionId: string;
}): Promise<number> =>
  (
    await params.db.drawing.updateMany({
      where: { ...ownedBoardsWhere(params.userId), collectionId: "trash" },
      data: { collectionId: params.trashCollectionId },
    })
  ).count;
