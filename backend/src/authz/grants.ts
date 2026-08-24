import type { AuthzDb } from "./client";
import { buildShareLinkToken, hashShareLinkToken, type DrawingPermission } from "./sharing";

/**
 * Writing and revoking board grants.
 *
 * getDrawingAccess answers "what may this account do"; this file is where that
 * answer gets changed. Both live behind the same boundary because NIL-323
 * reshapes the rows they read and write, and a route that writes the row
 * directly would keep compiling against a shape that no longer decides
 * anything.
 *
 * Nothing here checks permission. Whether the caller may administer the board
 * is `controlsDrawing`, asked first, at the route.
 */

/** Everyone with a standing grant on the board, for the owner's sharing panel. */
export const listDrawingPermissions = async (params: { db: AuthzDb; drawingId: string }) =>
  params.db.drawingPermission.findMany({
    where: { drawingId: params.drawingId },
    select: {
      id: true,
      granteeUserId: true,
      permission: true,
      createdAt: true,
      updatedAt: true,
      granteeUser: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });

export const grantDrawingPermission = async (params: {
  db: AuthzDb;
  drawingId: string;
  granteeUserId: string;
  permission: DrawingPermission;
  grantedByUserId: string;
}) =>
  params.db.drawingPermission.upsert({
    where: {
      drawingId_granteeUserId: {
        drawingId: params.drawingId,
        granteeUserId: params.granteeUserId,
      },
    },
    update: { permission: params.permission, createdByUserId: params.grantedByUserId },
    create: {
      drawingId: params.drawingId,
      granteeUserId: params.granteeUserId,
      permission: params.permission,
      createdByUserId: params.grantedByUserId,
    },
    select: {
      id: true,
      granteeUserId: true,
      permission: true,
      createdAt: true,
      updatedAt: true,
      granteeUser: { select: { id: true, name: true, email: true } },
    },
  });

/**
 * Revoke one grant, and say whose it was.
 *
 * The grantee comes back because the caller has to drop that person's live
 * sockets, and after the delete there is nobody left to ask. Scoped by board
 * as well as by id so a grant id from another board cannot be revoked through
 * a board the caller happens to control.
 */
export const revokeDrawingPermission = async (params: {
  db: AuthzDb;
  drawingId: string;
  permissionId: string;
}): Promise<{ revoked: boolean; granteeUserId: string | null }> => {
  const existing = await params.db.drawingPermission.findFirst({
    where: { id: params.permissionId, drawingId: params.drawingId },
    select: { granteeUserId: true },
  });
  const deleted = await params.db.drawingPermission.deleteMany({
    where: { id: params.permissionId, drawingId: params.drawingId },
  });
  return {
    revoked: deleted.count > 0,
    granteeUserId: deleted.count > 0 ? (existing?.granteeUserId ?? null) : null,
  };
};

/** The board's link shares, secrets excluded -- `tokenHash` never leaves this file. */
export const listDrawingLinkShares = async (params: { db: AuthzDb; drawingId: string }) =>
  params.db.drawingLinkShare.findMany({
    where: { drawingId: params.drawingId },
    select: {
      id: true,
      permission: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      updatedAt: true,
      lastUsedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

/**
 * Which of these boards currently have an active (not revoked, not expired)
 * link share -- the owner-only exposure signal `drawingListRoutes.ts` shows
 * as `linkShared` (NIL-290). Batched for a whole list response, same
 * "five queries for a page, not one per card" reasoning as
 * `authz/roster.ts`'s `getDrawingRosters`. Same "active" predicate as
 * `authz/sharing.ts`'s `getActiveLinkShareAccess` -- kept as a second,
 * batched query rather than reused directly because that one is scoped to a
 * single board and a single token.
 */
export const getBoardsWithActiveLinkShare = async (params: {
  db: AuthzDb;
  drawingIds: readonly string[];
  now?: Date;
}): Promise<Set<string>> => {
  if (params.drawingIds.length === 0) return new Set();
  const rows = await params.db.drawingLinkShare.findMany({
    where: {
      drawingId: { in: [...params.drawingIds] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: params.now ?? new Date() } }],
    },
    select: { drawingId: true },
  });
  return new Set(rows.map((row) => row.drawingId));
};

/**
 * Issue a link share, revoking whatever was active before it.
 *
 * Both halves are one transaction on purpose: a reissued link must be
 * independent of every URL shared before it, and a crash between the revoke
 * and the create would leave two live secrets on one board.
 *
 * The clear-text token is returned once and never stored -- only its hash goes
 * to the database, so a database read cannot reconstruct a working URL.
 */
export const issueDrawingLinkShare = async (params: {
  db: AuthzDb;
  drawingId: string;
  permission: DrawingPermission;
  expiresAt: Date | null;
  createdByUserId: string;
}): Promise<{
  token: string;
  share: {
    id: string;
    permission: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  };
}> => {
  const token = buildShareLinkToken();
  await params.db.drawingLinkShare.updateMany({
    where: { drawingId: params.drawingId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const share = await params.db.drawingLinkShare.create({
    data: {
      drawingId: params.drawingId,
      permission: params.permission,
      tokenHash: hashShareLinkToken(token),
      // Passphrase support is currently disabled; the column stays nullable
      // for backwards compatibility.
      passphraseHash: null,
      expiresAt: params.expiresAt,
      createdByUserId: params.createdByUserId,
    },
    select: {
      id: true,
      permission: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  return { token, share };
};

/** Revoke one still-active link share. False when it was already revoked or absent. */
export const revokeDrawingLinkShare = async (params: {
  db: AuthzDb;
  drawingId: string;
  shareId: string;
}): Promise<boolean> =>
  (
    await params.db.drawingLinkShare.updateMany({
      where: { id: params.shareId, drawingId: params.drawingId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  ).count > 0;

/**
 * Hand every grant this person authored to their successor.
 *
 * Offboarding, not authorization: `createdByUserId` records who granted a
 * right, and it is a plain string rather than a relation, so a cascade cannot
 * follow it when the account goes away. Nobody's access changes here.
 *
 * Returned as operations rather than awaited, because offboarding runs as one
 * batch `$transaction([...])` -- half a reassignment is worse than none. This
 * is also the only reason the contract accepts a transaction client at all:
 * these three calls were the boundary's blind spot before it existed.
 */
export const reassignGrantAuthorshipOps = (params: {
  db: AuthzDb;
  fromUserId: string;
  toUserId: string;
}) => [
  params.db.drawingPermission.updateMany({
    where: { createdByUserId: params.fromUserId },
    data: { createdByUserId: params.toUserId },
  }),
  params.db.drawingLinkShare.updateMany({
    where: { createdByUserId: params.fromUserId },
    data: { createdByUserId: params.toUserId },
  }),
  params.db.collectionShare.updateMany({
    where: { createdByUserId: params.fromUserId },
    data: { createdByUserId: params.toUserId },
  }),
];
