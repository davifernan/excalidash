import type { AuthzDb } from "./client";
import {
  normalizeDrawingPermission,
  type CollectionShareRole,
  type DrawingPermission,
} from "./sharing";

/**
 * Collection-level ownership and grants.
 *
 * Routes used to ask `collection.findFirst({ where: { id, userId } })` and read
 * the answer as "may I". That works today and stops working in NIL-323, which
 * replaces the ownership model -- and the failure is a route that silently
 * matches nothing, which reads as a 404 rather than as a bug.
 *
 * Everything here answers a question instead of describing a query, so the
 * replacement happens in this file.
 */

/** May this account administer the collection -- rename, delete, share it. */
export const controlsCollection = async (params: {
  db: AuthzDb;
  userId: string;
  collectionId: string;
}): Promise<boolean> => (await getOwnedCollection(params)) !== null;

/**
 * The collection, but only if this account owns it.
 *
 * Returns null both when the collection does not exist and when it belongs to
 * someone else. Callers must not tell those apart: distinguishing them turns
 * the endpoint into an oracle for which collection ids exist.
 */
export const getOwnedCollection = async (params: {
  db: AuthzDb;
  userId: string;
  collectionId: string;
}) =>
  params.db.collection.findFirst({
    where: { id: params.collectionId, userId: params.userId },
  });

/** Every collection this account owns, newest first. */
export const listOwnedCollections = async (params: { db: AuthzDb; userId: string }) =>
  params.db.collection.findMany({
    where: { userId: params.userId },
    orderBy: { createdAt: "desc" },
  });

/**
 * This account's standing level on a collection, or null.
 *
 * Ownership outranks any share, so it is answered first: a collection's owner
 * who also holds a stale `view` share must not be read as a viewer.
 */
export const getCollectionAccess = async (params: {
  db: AuthzDb;
  userId: string;
  collectionId: string;
}): Promise<"owner" | DrawingPermission | null> => {
  if (await controlsCollection(params)) return "owner";
  const share = await params.db.collectionShare.findFirst({
    where: { collectionId: params.collectionId, granteeUserId: params.userId },
    select: { role: true },
  });
  return normalizeDrawingPermission(share?.role);
};

/**
 * The level this account was granted on a collection it does not own, or null.
 *
 * Separate from getCollectionAccess so a caller that has already established
 * ownership does not pay for a second ownership query -- and so the two
 * questions stay distinguishable: "what was I granted" is not "what may I do".
 */
export const getCollectionShareLevel = async (params: {
  db: AuthzDb;
  userId: string;
  collectionId: string;
}): Promise<DrawingPermission | null> =>
  normalizeDrawingPermission(
    (
      await params.db.collectionShare.findFirst({
        where: { collectionId: params.collectionId, granteeUserId: params.userId },
        select: { role: true },
      })
    )?.role,
  );

/** Which of these collections have at least one share. */
export const collectionsWithShares = async (params: {
  db: AuthzDb;
  collectionIds: readonly string[];
}): Promise<Set<string>> => {
  if (params.collectionIds.length === 0) return new Set();
  const rows = await params.db.collectionShare.groupBy({
    by: ["collectionId"],
    where: { collectionId: { in: [...params.collectionIds] } },
    _count: { collectionId: true },
  });
  return new Set(rows.map((row) => row.collectionId));
};

/**
 * Collections other people shared with this account.
 *
 * Projected field by field on purpose: spreading the row handed every grantee
 * the owner's email address, which navigation never needed.
 */
export const listCollectionsSharedWith = async (params: { db: AuthzDb; userId: string }) =>
  params.db.collectionShare.findMany({
    where: { granteeUserId: params.userId },
    include: { collection: { include: { user: { select: { name: true } } } } },
  });

/** The ids of collections shared with this account. */
export const listSharedCollectionIds = async (params: {
  db: AuthzDb;
  userId: string;
}): Promise<string[]> =>
  (
    await params.db.collectionShare.findMany({
      where: { granteeUserId: params.userId },
      select: { collectionId: true },
    })
  ).map((row) => row.collectionId);

/** The share rows on a collection, for the owner's member list. */
export const listCollectionShares = async (params: { db: AuthzDb; collectionId: string }) =>
  params.db.collectionShare.findMany({
    where: { collectionId: params.collectionId },
    include: { granteeUser: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

/** Just the accounts a collection is shared with. */
export const listCollectionGranteeIds = async (params: {
  db: AuthzDb;
  collectionId: string;
}): Promise<string[]> =>
  (
    await params.db.collectionShare.findMany({
      where: { collectionId: params.collectionId },
      select: { granteeUserId: true },
    })
  ).map((row) => row.granteeUserId);

export const grantCollectionShare = async (params: {
  db: AuthzDb;
  collectionId: string;
  granteeUserId: string;
  role: CollectionShareRole;
  grantedByUserId: string;
}) =>
  params.db.collectionShare.upsert({
    where: {
      collectionId_granteeUserId: {
        collectionId: params.collectionId,
        granteeUserId: params.granteeUserId,
      },
    },
    update: { role: params.role, updatedAt: new Date() },
    create: {
      collectionId: params.collectionId,
      granteeUserId: params.granteeUserId,
      role: params.role,
      createdByUserId: params.grantedByUserId,
    },
    include: { granteeUser: { select: { id: true, name: true, email: true } } },
  });

/** False when there was no such share to change. */
export const changeCollectionShareRole = async (params: {
  db: AuthzDb;
  collectionId: string;
  granteeUserId: string;
  role: CollectionShareRole;
}): Promise<boolean> =>
  (
    await params.db.collectionShare.updateMany({
      where: { collectionId: params.collectionId, granteeUserId: params.granteeUserId },
      data: { role: params.role, updatedAt: new Date() },
    })
  ).count > 0;

/** False when there was no such share to revoke. */
export const revokeCollectionShare = async (params: {
  db: AuthzDb;
  collectionId: string;
  granteeUserId: string;
}): Promise<boolean> =>
  (
    await params.db.collectionShare.deleteMany({
      where: { collectionId: params.collectionId, granteeUserId: params.granteeUserId },
    })
  ).count > 0;

/** Rename a collection this account owns. Count of rows changed. */
export const renameOwnedCollection = async (params: {
  db: AuthzDb;
  userId: string;
  collectionId: string;
  name: string;
}): Promise<number> =>
  (
    await params.db.collection.updateMany({
      where: { id: params.collectionId, userId: params.userId },
      data: { name: params.name },
    })
  ).count;

/**
 * Revoke every share on a collection.
 *
 * Returned rather than awaited so it can join a batch `$transaction([...])`.
 * The alternative was to let the route keep the table name for that one call,
 * which is exactly the "only this one place" the boundary exists to refuse.
 */
export const revokeAllCollectionSharesOp = (params: { db: AuthzDb; collectionId: string }) =>
  params.db.collectionShare.deleteMany({ where: { collectionId: params.collectionId } });

/** Delete the collection, but only if this account still owns it. */
export const deleteOwnedCollectionOp = (params: {
  db: AuthzDb;
  userId: string;
  collectionId: string;
}) =>
  params.db.collection.deleteMany({
    where: { id: params.collectionId, userId: params.userId },
  });
