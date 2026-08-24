import express from "express";
import { Prisma } from "../../generated/client";
import { normalizeDrawingPermission } from "../../authz/sharing";
import { getDrawingMemberProjections } from "../../authz/drawingMembers";
import { getUserTrashCollectionId, toPublicTrashCollectionId } from "./trash";
import { SortDirection, SortField } from "./types";
import type { DrawingRouteContext } from "./drawingRouteContext";
import { getCollectionAccess, listSharedCollectionIds } from "../../authz/collections";
import { boardsSharedWithWhere, grantedLevelSelect, ownedBoardsWhere } from "../../authz/boards";

const DEFAULT_PAGE_SIZE = 50;

const parsePageLimit = (value: unknown, maxPageSize: number): number => {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) return Math.min(DEFAULT_PAGE_SIZE, maxPageSize);
  return Math.min(Math.max(parsed, 1), maxPageSize);
};

export const registerDrawingListRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    parseJsonField,
    subjectKeySecret,
    buildDrawingsCacheKey,
    getCachedDrawingsBody,
    cacheDrawingsResponse,
    MAX_PAGE_SIZE,
  } = context;
  app.get(
    "/drawings",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const trashCollectionId = getUserTrashCollectionId(req.user.id);
      const {
        search,
        collectionId,
        includeData,
        includePreview,
        limit,
        offset,
        sortField,
        sortDirection,
      } = req.query;
      // NIL-365: archived boards are excluded from the plain drawing lists by
      // default -- they live in the dedicated Archive view
      // (`GET /search?archivedOnly=true`), not silently mixed into "All
      // Drawings" or a collection's contents.
      const where: Prisma.DrawingWhereInput = {
        ...ownedBoardsWhere(req.user.id),
        archivedAt: null,
      };
      const searchTerm =
        typeof search === "string" && search.trim().length > 0 ? search.trim() : undefined;

      if (searchTerm) {
        where.name = { contains: searchTerm };
      }

      let collectionFilterKey = "default";
      if (collectionId === "null") {
        where.collectionId = null;
        collectionFilterKey = "null";
      } else if (collectionId) {
        const normalizedCollectionId = String(collectionId);
        if (normalizedCollectionId === "trash") {
          where.collectionId = { in: [trashCollectionId, "trash"] };
          collectionFilterKey = "trash";
        } else {
          const collection = await prisma.collection.findFirst({
            where: { id: normalizedCollectionId },
          });
          if (!collection) {
            return res.status(404).json({ error: "Collection not found" });
          }

          // Owner or grantee -- one question, one answer. A collection the
          // account has no claim on is reported as absent rather than as
          // forbidden, so the endpoint cannot be used to test which ids exist.
          const collectionAccess = await getCollectionAccess({
            db: prisma,
            userId: req.user.id,
            collectionId: normalizedCollectionId,
          });
          if (!collectionAccess) {
            return res.status(404).json({ error: "Collection not found" });
          }
          // Always fetch all drawings in the collection regardless of who created them
          delete (where as any).userId;

          where.collectionId = normalizedCollectionId;
          collectionFilterKey = `id:${normalizedCollectionId}`;
        }
      } else {
        where.OR = [
          { collectionId: { notIn: [trashCollectionId, "trash"] } },
          { collectionId: null },
        ];
      }

      const shouldIncludeData =
        typeof includeData === "string"
          ? includeData.toLowerCase() === "true" || includeData === "1"
          : false;
      const shouldIncludePreview =
        typeof includePreview === "string"
          ? includePreview.toLowerCase() === "true" || includePreview === "1"
          : false;
      const parsedSortField: SortField =
        sortField === "name" || sortField === "createdAt" || sortField === "updatedAt"
          ? sortField
          : "updatedAt";
      const parsedSortDirection: SortDirection =
        sortDirection === "asc" || sortDirection === "desc"
          ? sortDirection
          : parsedSortField === "name"
            ? "asc"
            : "desc";

      const rawOffset = offset ? Number.parseInt(offset as string, 10) : undefined;
      const parsedLimit = parsePageLimit(limit, MAX_PAGE_SIZE);
      const parsedOffset =
        rawOffset !== undefined && Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : undefined;
      // API keys are automation credentials. They can list drawings, but do
      // not need the human roster attached to each card.
      const includeMembers = req.user.authCredentialType !== "apiKey";

      const cacheKey =
        buildDrawingsCacheKey({
          userId: req.user.id,
          searchTerm: searchTerm ?? "",
          collectionFilter: collectionFilterKey,
          includeData: shouldIncludeData,
          sortField: parsedSortField,
          sortDirection: parsedSortDirection,
        }) +
        `:${parsedLimit}:${parsedOffset}:preview=${shouldIncludePreview ? "1" : "0"}:members=${includeMembers ? "1" : "0"}`;

      const cachedBody = getCachedDrawingsBody(cacheKey);
      if (cachedBody) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("Content-Type", "application/json");
        return res.send(cachedBody);
      }

      const summarySelect: Prisma.DrawingSelect = {
        id: true,
        name: true,
        collectionId: true,
        ...(shouldIncludePreview ? { preview: true } : {}),
        version: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true } },
        createdBy: { select: { name: true } },
      };

      const orderBy: Prisma.DrawingOrderByWithRelationInput =
        parsedSortField === "name"
          ? { name: parsedSortDirection }
          : parsedSortField === "createdAt"
            ? { createdAt: parsedSortDirection }
            : { updatedAt: parsedSortDirection };

      const queryOptions: Prisma.DrawingFindManyArgs = { where, orderBy, take: parsedLimit };
      if (parsedOffset !== undefined) queryOptions.skip = parsedOffset;
      if (!shouldIncludeData) queryOptions.select = summarySelect;

      const [drawings, totalCount] = await Promise.all([
        prisma.drawing.findMany(queryOptions),
        prisma.drawing.count({ where }),
      ]);

      let responsePayload: any[] = drawings as any[];
      if (shouldIncludeData) {
        responsePayload = (drawings as any[]).map((d: any) => ({
          ...d,
          collectionId: toPublicTrashCollectionId(d.collectionId, req.user!.id),
          elements: parseJsonField(d.elements, []),
          appState: parseJsonField(d.appState, {}),
          files: parseJsonField(d.files, {}),
          creatorName: d.createdBy?.name ?? d.user?.name ?? null,
          user: undefined,
          createdBy: undefined,
        }));
      } else {
        responsePayload = (drawings as any[]).map((d: any) => ({
          ...d,
          collectionId: toPublicTrashCollectionId(d.collectionId, req.user!.id),
          // Who drew it, which is not always who controls it.
          creatorName: d.createdBy?.name ?? d.user?.name ?? null,
          user: undefined,
          createdBy: undefined,
        }));
      }

      if (includeMembers) {
        const members = await getDrawingMemberProjections({
          prisma,
          drawingIds: responsePayload.map((d) => d.id),
          viewerId: req.user.id,
          secret: subjectKeySecret,
        });
        for (const drawing of responsePayload) {
          drawing.members = members.get(drawing.id) ?? { totalCount: 0, items: [] };
        }
      }

      const finalResponse = {
        drawings: responsePayload,
        totalCount,
        limit: parsedLimit,
        offset: parsedOffset,
      };

      const body = cacheDrawingsResponse(cacheKey, finalResponse);
      res.setHeader("X-Cache", "MISS");
      res.setHeader("Content-Type", "application/json");
      return res.send(body);
    }),
  );

  // Shared with me list (does not mix into /drawings cache semantics)
  // Must be registered before `/drawings/:id` so it doesn't get treated as a drawing id.
  app.get(
    "/drawings/shared",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { search, includeData, includePreview, limit, offset, sortField, sortDirection } =
        req.query;
      const searchTerm =
        typeof search === "string" && search.trim().length > 0 ? search.trim() : undefined;

      const shouldIncludeData =
        typeof includeData === "string"
          ? includeData.toLowerCase() === "true" || includeData === "1"
          : false;
      const shouldIncludePreview =
        typeof includePreview === "string"
          ? includePreview.toLowerCase() === "true" || includePreview === "1"
          : false;
      const parsedSortField: SortField =
        sortField === "name" || sortField === "createdAt" || sortField === "updatedAt"
          ? sortField
          : "updatedAt";
      const parsedSortDirection: SortDirection =
        sortDirection === "asc" || sortDirection === "desc"
          ? sortDirection
          : parsedSortField === "name"
            ? "asc"
            : "desc";

      const rawOffset = offset ? Number.parseInt(offset as string, 10) : undefined;
      const parsedLimit = parsePageLimit(limit, MAX_PAGE_SIZE);
      const parsedOffset =
        rawOffset !== undefined && Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : undefined;

      const orderBy: Prisma.DrawingOrderByWithRelationInput =
        parsedSortField === "name"
          ? { name: parsedSortDirection }
          : parsedSortField === "createdAt"
            ? { createdAt: parsedSortDirection }
            : { updatedAt: parsedSortDirection };

      // Get collection IDs shared with this user to exclude drawings already visible via collection sharing
      const sharedColIds = await listSharedCollectionIds({ db: prisma, userId: req.user.id });

      const whereDrawing: Prisma.DrawingWhereInput = {
        ...boardsSharedWithWhere(req.user.id),
        archivedAt: null,
        // Exclude drawings already accessible via a shared collection
        ...(sharedColIds.length > 0 && {
          NOT: {
            collectionId: { in: sharedColIds },
          },
        }),
      };
      if (searchTerm) {
        whereDrawing.name = { contains: searchTerm };
      }

      const summarySelect: Prisma.DrawingSelect = {
        id: true,
        name: true,
        collectionId: true,
        ...(shouldIncludePreview ? { preview: true } : {}),
        version: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        user: { select: { name: true } },
        createdBy: { select: { name: true } },
        permissions: grantedLevelSelect(req.user.id),
      };

      const queryOptions: Prisma.DrawingFindManyArgs = {
        where: whereDrawing,
        orderBy,
        take: parsedLimit,
      };
      if (parsedOffset !== undefined) queryOptions.skip = parsedOffset;
      if (!shouldIncludeData) queryOptions.select = summarySelect;

      const [drawings, totalCount] = await Promise.all([
        prisma.drawing.findMany(queryOptions),
        prisma.drawing.count({ where: whereDrawing }),
      ]);

      const normalize = (d: any) => {
        const rawPerm = Array.isArray(d?.permissions) ? d.permissions[0]?.permission : null;
        const perm = normalizeDrawingPermission(rawPerm) ?? "view";
        const { permissions: _permissions, user: _user, createdBy: _createdBy, ...rest } = d;
        return {
          ...rest,
          // A board someone shared with you is worth a name.
          creatorName: d.createdBy?.name ?? d.user?.name ?? null,
          // Collections are owner-scoped; don't leak the owner's collection ids to viewers.
          collectionId: null,
          accessLevel: perm,
        };
      };

      let responsePayload: any[] = drawings as any[];
      if (shouldIncludeData) {
        responsePayload = (drawings as any[]).map((d: any) => {
          const normalized = normalize(d);
          return {
            ...normalized,
            elements: parseJsonField(d.elements, []),
            appState: parseJsonField(d.appState, {}),
            files: parseJsonField(d.files, {}),
          };
        });
      } else {
        responsePayload = (drawings as any[]).map((d: any) => normalize(d));
      }

      const sharedMembers = await getDrawingMemberProjections({
        prisma,
        drawingIds: responsePayload.map((d) => d.id),
        viewerId: req.user.id,
        secret: subjectKeySecret,
      });
      for (const drawing of responsePayload) {
        drawing.members = sharedMembers.get(drawing.id) ?? { totalCount: 0, items: [] };
      }

      return res.json({
        drawings: responsePayload,
        totalCount,
        limit: parsedLimit,
        offset: parsedOffset,
      });
    }),
  );
};
