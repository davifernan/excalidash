import type { AuthzDb } from "./client";

/**
 * Hand every Team Library item this account owns to a successor, the same
 * offboarding pattern `transferOwnedBoards`/`transferOwnedCollections`
 * (`boards.ts`) already use -- a departing account's items (personal or
 * team-visible alike) are not deleted, they change owner.
 *
 * `LibraryItem` carries `@@unique([ownerUserId, excalidrawItemId])`, so a
 * blind `updateMany` can collide: the successor may already own an item
 * with the same `excalidrawItemId` (a common template shape reused by more
 * than one account). A collision is resolved by keeping the successor's
 * existing row and dropping the departing account's duplicate, rather than
 * failing the whole offboarding transaction over a duplicate that would
 * have been redundant in the merged Team Library view anyway.
 *
 * Returns how many items were reassigned (not counting dropped duplicates).
 */
export const transferOwnedLibraryItems = async (params: {
  db: AuthzDb;
  fromUserId: string;
  toUserId: string;
}): Promise<number> => {
  const [fromItems, toItemIds] = await Promise.all([
    params.db.libraryItem.findMany({
      where: { ownerUserId: params.fromUserId },
      select: { id: true, excalidrawItemId: true },
    }),
    params.db.libraryItem
      .findMany({
        where: { ownerUserId: params.toUserId },
        select: { excalidrawItemId: true },
      })
      .then((rows) => new Set(rows.map((row) => row.excalidrawItemId))),
  ]);

  const colliding = fromItems.filter((item) => toItemIds.has(item.excalidrawItemId));
  const transferable = fromItems.filter((item) => !toItemIds.has(item.excalidrawItemId));

  if (colliding.length > 0) {
    await params.db.libraryItem.deleteMany({
      where: { id: { in: colliding.map((item) => item.id) } },
    });
  }
  if (transferable.length === 0) return 0;

  const result = await params.db.libraryItem.updateMany({
    where: { id: { in: transferable.map((item) => item.id) } },
    data: { ownerUserId: params.toUserId },
  });
  return result.count;
};
