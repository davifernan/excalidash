import express from "express";
import { Prisma } from "../../generated/client";
import { ownedBoardsWhere, ownedCollectionsWhere, boardsSharedWithWhere } from "../../authz/boards";
import { listSharedCollectionIds } from "../../authz/collections";
import { getDrawingMemberships } from "../../authz/membership";
import type { DrawingRouteContext } from "./drawingRouteContext";
import { findContentMatch } from "../../search/searchIndex";
import { toPublicTrashCollectionId } from "./trash";

const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * NIL-362/NIL-298/NIL-363: one merged, permission-aware search over
 * everything an account can see -- own boards, boards owned via a
 * collection this account controls, boards directly shared with this
 * account, and boards reachable through a shared collection. This is the
 * union `authz/membership.ts`'s `getDrawingMemberships` already computes
 * per-board; this route computes the same union as a `WHERE`, so a board
 * outside it is never fetched in the first place.
 *
 * This is the one rule the whole package answers to: filter in the query,
 * not the result. Every `where` clause below is built from an existing
 * `backend/src/authz/` export (`ownedBoardsWhere`, `ownedCollectionsWhere`,
 * `boardsSharedWithWhere`, `listSharedCollectionIds`) -- nothing here reads
 * `prisma.drawingPermission`/`collectionShare`/`drawingLinkShare` directly
 * or filters a board by a literal `userId:`, so a board this account has no
 * claim on cannot appear in `results`, in `totalCount`, or in how long the
 * request took to answer. An account with zero claims gets `{ results: [],
 * totalCount: 0 }` -- indistinguishable, on the wire, from "nothing on this
 * team matches yet".
 */
export const registerSearchRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const { prisma, requireAuth, asyncHandler, parseJsonField, MAX_PAGE_SIZE } = context;

  app.get(
    "/search",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const rawQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const includeArchived =
        typeof req.query.includeArchived === "string" &&
        (req.query.includeArchived.toLowerCase() === "true" || req.query.includeArchived === "1");
      const archivedOnly =
        typeof req.query.archivedOnly === "string" &&
        (req.query.archivedOnly.toLowerCase() === "true" || req.query.archivedOnly === "1");

      // An empty term is only allowed to browse the Archive view (list
      // everything archived, newest-archived first) -- a plain search still
      // requires a real term rather than matching every visible board.
      if (rawQuery.length < MIN_QUERY_LENGTH && !archivedOnly) {
        return res.json({ results: [], totalCount: 0, limit: DEFAULT_LIMIT, offset: 0 });
      }
      const term = rawQuery.toLowerCase();

      const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), Math.min(MAX_LIMIT, MAX_PAGE_SIZE))
        : DEFAULT_LIMIT;
      const rawOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
      const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

      const sharedCollectionIds = await listSharedCollectionIds({
        db: prisma,
        userId: req.user.id,
      });

      const visibilityOr: Prisma.DrawingWhereInput[] = [
        ownedBoardsWhere(req.user.id),
        { collection: ownedCollectionsWhere(req.user.id) },
        boardsSharedWithWhere(req.user.id),
      ];
      if (sharedCollectionIds.length > 0) {
        visibilityOr.push({ collectionId: { in: sharedCollectionIds } });
      }

      const where: Prisma.DrawingWhereInput = {
        OR: visibilityOr,
        searchText: { contains: term },
        archivedAt: archivedOnly ? { not: null } : includeArchived ? undefined : null,
      };

      const [rows, totalCount] = await Promise.all([
        prisma.drawing.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          take: limit,
          skip: offset,
          select: {
            id: true,
            name: true,
            elements: true,
            collectionId: true,
            archivedAt: true,
            updatedAt: true,
            createdAt: true,
            version: true,
            userId: true,
            createdBy: { select: { name: true } },
            user: { select: { name: true } },
          },
        }),
        prisma.drawing.count({ where }),
      ]);

      // Display-only: every row already passed the visibility `where` above,
      // so this batch lookup decides how a result is labeled ("owner" /
      // "shared" / "view"), never whether it is returned.
      const memberships = await getDrawingMemberships({
        prisma,
        userId: req.user.id,
        drawingIds: rows.map((row) => row.id),
      });

      const results = rows.map((row) => {
        const nameMatches = row.name.toLowerCase().includes(term);
        const contentMatch = findContentMatch(parseJsonField(row.elements, []), term);
        return {
          id: row.id,
          name: row.name,
          collectionId: toPublicTrashCollectionId(row.collectionId, req.user!.id),
          archivedAt: row.archivedAt,
          updatedAt: row.updatedAt,
          createdAt: row.createdAt,
          version: row.version,
          creatorName: row.createdBy?.name ?? row.user?.name ?? null,
          accessLevel: memberships.get(row.id)?.level ?? null,
          matchKind: nameMatches ? "name" : "content",
          elementId: contentMatch?.elementId ?? null,
          snippet: contentMatch?.snippet ?? null,
        };
      });

      return res.json({ results, totalCount, limit, offset });
    }),
  );
};
