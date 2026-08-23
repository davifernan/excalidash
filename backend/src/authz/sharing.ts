import type { PrismaClient } from "../generated/client";
import crypto from "crypto";
import { hashTokenForStorage } from "../auth/tokenSecurity";

/**
 * The grantable levels, weakest first.
 *
 * `"comment"` sits between seeing and changing (NIL-487). It is a third thing a
 * person may do to a board, not a variant of the other two: a reviewer may
 * leave a note on a diagram without being able to move a box, and today that
 * person has to be given `"edit"` -- which grants far more than was meant.
 *
 * It is added here, ahead of any feature that hands it out, on purpose. The
 * column is a plain String. If NIL-324 starts writing `"comment"` while a
 * reader still normalizes it to null, a granted share reads back as NO ACCESS:
 * a silent revocation, green in every test, visible only to the person locked
 * out. Every reader has to understand a level before anything writes it.
 *
 * Nothing in this PR grants it. `"view"` and `"edit"` keep their exact meaning.
 */
export type DrawingPermission = "view" | "comment" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

/**
 * One ranking for the whole contract.
 *
 * membership.ts and roster.ts each carried their own copy of this table. Two
 * copies of an ordering means adding a level is a change in three files that
 * type-checks after the first -- and the missed copies sort a `"comment"` claim
 * as unknown, which `strongest()` then quietly loses against anything else.
 * A level is a property of the contract, so the ordering lives with it.
 */
export const ACCESS_RANK: Record<DrawingAccess, number> = {
  none: 0,
  view: 1,
  comment: 2,
  edit: 3,
  owner: 4,
};

export type DrawingPrincipal = {
  kind: "user";
  userId: string;
  /**
   * Only the auth-disabled bootstrap identity may represent an inactive row.
   * Real JWT/API-key principals must be revalidated on access; the live socket
   * path may coalesce this one status read for a few hundred milliseconds and
   * explicitly invalidates it on account changes.
   */
  allowInactive?: boolean;
  apiKey?: {
    id: string;
    scopes: readonly string[];
  };
};

export const normalizeDrawingPermission = (input: unknown): DrawingPermission | null => {
  if (input === "view" || input === "comment" || input === "edit") return input;
  return null;
};

export const buildShareLinkToken = (): string => crypto.randomBytes(24).toString("base64url");

export const hashShareLinkToken = (token: string): string => hashTokenForStorage(token);

export const parseShareLinkToken = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  const token = input.trim();
  return /^[A-Za-z0-9_-]{32}$/.test(token) ? token : null;
};

export const shareLinkTokenFromRequest = (req: {
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
}): string | null =>
  parseShareLinkToken(req.headers["x-share-token"]) ?? parseShareLinkToken(req.query.shareToken);

export const shareLinkTokenMatches = (providedToken: string, storedHash: string): boolean => {
  const actual = Buffer.from(hashShareLinkToken(providedToken), "hex");
  const storedHashIsValid = /^[0-9a-f]{64}$/i.test(storedHash);
  const expected = Buffer.from(storedHashIsValid ? storedHash : "0".repeat(64), "hex");
  const matches = crypto.timingSafeEqual(actual, expected);
  return storedHashIsValid && matches;
};

export const getDrawingAccess = async (params: {
  prisma: PrismaClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  shareToken?: string | null;
  now?: Date;
  isUserActive?: (userId: string) => Promise<boolean>;
}): Promise<DrawingAccess> => {
  const nowMs = (params.now ?? new Date()).getTime();

  let baseAccess: DrawingAccess = "none";

  // User-based access (owner or explicit ACL).
  if (params.principal?.kind === "user") {
    if (!params.principal.allowInactive) {
      const accountIsActive = params.isUserActive
        ? await params.isUserActive(params.principal.userId)
        : Boolean(
            (
              await params.prisma.user.findUnique({
                where: { id: params.principal.userId },
                select: { isActive: true },
              })
            )?.isActive,
          );
      // An authenticated inactive account must not retain access through a
      // public-link fallback on an already established connection.
      if (!accountIsActive) return "none";
    }
    const drawing = await params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: { userId: true, collectionId: true },
    });
    if (!drawing) return "none";
    if (drawing.userId === params.principal.userId) return "owner";

    const perm = await params.prisma.drawingPermission.findUnique({
      where: {
        drawingId_granteeUserId: {
          drawingId: params.drawingId,
          granteeUserId: params.principal.userId,
        },
      },
      select: { permission: true },
    });
    baseAccess = maxAccess(baseAccess, normalizeDrawingPermission(perm?.permission) ?? "none");

    // Both claims are always evaluated. Stopping at the direct permission let a
    // narrow one hide a wider inherited one: someone with edit on the collection
    // lost the right to write the moment they were also granted view on a single
    // drawing in it, which reads as a share and behaves as a revocation.
    if (drawing.collectionId) {
      // The collection's owner controls what is in it, including boards created
      // there by someone they shared it with.
      const ownedCollection = await params.prisma.collection.findFirst({
        where: {
          id: drawing.collectionId,
          userId: params.principal.userId,
        },
        select: { id: true },
      });
      if (ownedCollection) {
        baseAccess = "owner";
      } else {
        const collectionShare = await params.prisma.collectionShare.findFirst({
          where: {
            collectionId: drawing.collectionId,
            granteeUserId: params.principal.userId,
          },
          select: { role: true },
        });
        baseAccess = maxAccess(
          baseAccess,
          normalizeDrawingPermission(collectionShare?.role) ?? "none",
        );
      }
    }
  }

  // Link access is additive to account access, but only possession of the
  // current secret activates it. The drawing id is an object identifier, not
  // an authorization credential.
  const linkPolicy = params.shareToken
    ? await getActiveLinkShareAccess({
        prisma: params.prisma,
        drawingId: params.drawingId,
        shareToken: params.shareToken,
        nowMs,
      })
    : null;
  const linkAccess: DrawingAccess = linkPolicy ?? "none";

  return maxAccess(baseAccess, linkAccess);
};

export const canViewDrawing = (access: DrawingAccess): access is Exclude<DrawingAccess, "none"> =>
  access !== "none";

/**
 * Unchanged by `"comment"`, and that is the whole point.
 *
 * Commenting is not a weak form of editing -- it must not open a single write
 * path that `"view"` does not already open. Written as an explicit membership
 * test rather than `rank >= edit` so that inserting a level below `edit` can
 * never widen it by arithmetic.
 */
export const canEditDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "edit" | "owner"> => access === "edit" || access === "owner";

/** May annotate without changing the drawing itself. Implied by edit and owner. */
export const canCommentDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "comment" | "edit" | "owner"> =>
  access === "comment" || access === "edit" || access === "owner";

export const isOwnerAccess = (access: DrawingAccess): boolean => access === "owner";

const getActiveLinkShareAccess = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  shareToken: string;
  nowMs: number;
}): Promise<DrawingPermission | null> => {
  const linkShare = await params.prisma.drawingLinkShare.findFirst({
    where: {
      drawingId: params.drawingId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(params.nowMs) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { permission: true, tokenHash: true },
  });
  if (!linkShare || !shareLinkTokenMatches(params.shareToken, linkShare.tokenHash)) return null;
  return normalizeDrawingPermission(linkShare?.permission);
};

const accessRank = (access: DrawingAccess): number => ACCESS_RANK[access] ?? 0;

const maxAccess = (a: DrawingAccess, b: DrawingAccess): DrawingAccess =>
  accessRank(a) >= accessRank(b) ? a : b;
