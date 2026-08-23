import type { PrismaClient } from "../generated/client";
import { ACCESS_RANK, normalizeDrawingPermission } from "./sharing";
import type { MembershipLevel } from "./membership";

/**
 * The roster answers "who has a standing claim on this board", which is what a
 * team wants to see next to "who is here right now". Link shares are absent on
 * purpose: holding a URL is not a seat at the table, and listing link holders
 * would turn a forwarded link into a name.
 *
 * Rows carry the account id because callers need it to match a person against
 * live presence. It must be projected to an opaque key before it leaves the
 * server.
 */
export type RosterMember = {
  userId: string;
  name: string;
  level: MembershipLevel;
  via: "drawing" | "collection";
};

/** The contract's ordering, not a second copy of it. See ACCESS_RANK in sharing.ts. */
const LEVEL_RANK = ACCESS_RANK;

type Claim = { level: MembershipLevel; via: "drawing" | "collection" };

const strongest = (a: Claim | undefined, b: Claim): Claim =>
  !a || LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a;

const uniqueIds = (values: readonly unknown[]): string[] =>
  Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && !!value)),
  );

const namesFor = async (prisma: PrismaClient, userIds: string[]): Promise<Map<string, string>> => {
  if (userIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, isActive: true },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
};

const toMembers = (claims: Map<string, Claim>, names: Map<string, string>): RosterMember[] => {
  const members: RosterMember[] = [];
  for (const [userId, claim] of claims) {
    const name = names.get(userId);
    // A deactivated account keeps its rows but stops being a colleague.
    if (!name) continue;
    members.push({ userId, name, level: claim.level, via: claim.via });
  }
  return members.sort(
    (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.name.localeCompare(b.name),
  );
};

export const getCollectionRoster = async (params: {
  prisma: PrismaClient;
  collectionId: string;
}): Promise<RosterMember[]> => {
  const collection = await params.prisma.collection.findUnique({
    where: { id: params.collectionId },
    select: { userId: true },
  });
  if (!collection) return [];
  const shares = await params.prisma.collectionShare.findMany({
    where: { collectionId: params.collectionId },
    select: { granteeUserId: true, role: true },
  });

  const claims = new Map<string, Claim>();
  claims.set(collection.userId, { level: "owner", via: "collection" });
  for (const share of shares) {
    const level = normalizeDrawingPermission(share.role);
    if (!level) continue;
    claims.set(
      share.granteeUserId,
      strongest(claims.get(share.granteeUserId), { level, via: "collection" }),
    );
  }

  return toMembers(claims, await namesFor(params.prisma, Array.from(claims.keys())));
};

/**
 * Five queries for a whole dashboard page, not five per card.
 */
export const getDrawingRosters = async (params: {
  prisma: PrismaClient;
  drawingIds: readonly string[];
}): Promise<Map<string, RosterMember[]>> => {
  const rosters = new Map<string, RosterMember[]>();
  const ids = uniqueIds(params.drawingIds);
  if (ids.length === 0) return rosters;

  const drawings = await params.prisma.drawing.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true, collectionId: true },
  });
  if (drawings.length === 0) return rosters;

  const presentIds = drawings.map((drawing) => drawing.id);
  const collectionIds = uniqueIds(drawings.map((drawing) => drawing.collectionId));

  const [permissions, collections, collectionShares] = await Promise.all([
    params.prisma.drawingPermission.findMany({
      where: { drawingId: { in: presentIds } },
      select: { drawingId: true, granteeUserId: true, permission: true },
    }),
    collectionIds.length
      ? params.prisma.collection.findMany({
          where: { id: { in: collectionIds } },
          select: { id: true, userId: true },
        })
      : Promise.resolve([] as { id: string; userId: string }[]),
    collectionIds.length
      ? params.prisma.collectionShare.findMany({
          where: { collectionId: { in: collectionIds } },
          select: { collectionId: true, granteeUserId: true, role: true },
        })
      : Promise.resolve([] as { collectionId: string; granteeUserId: string; role: string }[]),
  ]);

  const collectionClaims = new Map<string, Map<string, Claim>>();
  for (const collection of collections) {
    const claims = new Map<string, Claim>();
    claims.set(collection.userId, { level: "owner", via: "collection" });
    collectionClaims.set(collection.id, claims);
  }
  for (const share of collectionShares) {
    const level = normalizeDrawingPermission(share.role);
    const claims = collectionClaims.get(share.collectionId);
    if (!level || !claims) continue;
    claims.set(
      share.granteeUserId,
      strongest(claims.get(share.granteeUserId), { level, via: "collection" }),
    );
  }

  const permissionsByDrawing = new Map<string, typeof permissions>();
  for (const permission of permissions) {
    const list = permissionsByDrawing.get(permission.drawingId) || [];
    list.push(permission);
    permissionsByDrawing.set(permission.drawingId, list);
  }

  const claimsByDrawing = new Map<string, Map<string, Claim>>();
  const everyone = new Set<string>();
  for (const drawing of drawings) {
    const claims = new Map<string, Claim>(
      drawing.collectionId ? collectionClaims.get(drawing.collectionId) : undefined,
    );
    claims.set(
      drawing.userId,
      strongest(claims.get(drawing.userId), { level: "owner", via: "drawing" }),
    );
    for (const permission of permissionsByDrawing.get(drawing.id) || []) {
      const level = normalizeDrawingPermission(permission.permission);
      if (!level) continue;
      claims.set(
        permission.granteeUserId,
        strongest(claims.get(permission.granteeUserId), { level, via: "drawing" }),
      );
    }
    claimsByDrawing.set(drawing.id, claims);
    for (const userId of claims.keys()) everyone.add(userId);
  }

  const names = await namesFor(params.prisma, Array.from(everyone));
  for (const [drawingId, claims] of claimsByDrawing) {
    rosters.set(drawingId, toMembers(claims, names));
  }
  return rosters;
};
