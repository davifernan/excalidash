import type { Prisma } from "../generated/client";
import type { AuthzDb } from "./client";

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
 * Hand every board this account owns to a successor, detached from collections.
 *
 * Offboarding, and the one place ownership changes in bulk. It is here rather
 * than in the offboarding routine because it is the same claim NIL-323
 * redefines: after that rework, "the boards this account owns" is no longer a
 * column match, and a transfer written as one would silently move the wrong
 * set -- or none.
 *
 * Collections are personal organization and do not survive the handover.
 * Returns how many boards moved.
 */
export const transferOwnedBoards = async (params: {
  db: AuthzDb;
  fromUserId: string;
  toUserId: string;
}): Promise<number> =>
  (
    await params.db.drawing.updateMany({
      where: ownedBoardsWhere(params.fromUserId),
      data: { userId: params.toUserId, collectionId: null },
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
