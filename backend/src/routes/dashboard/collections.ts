import express from "express";
import { DashboardRouteDeps } from "./types";
import { getUserTrashCollectionId, isTrashCollectionId } from "./trash";
import {
  changeCollectionShareRole,
  collectionsWithShares,
  controlsCollection,
  deleteOwnedCollectionOp,
  getOwnedCollection,
  grantCollectionShare,
  listCollectionGranteeIds,
  listCollectionShares,
  listCollectionsSharedWith,
  listOwnedCollections,
  renameOwnedCollection,
  revokeAllCollectionSharesOp,
  revokeCollectionShare,
} from "../../authz/collections";
import { normalizeCollectionShareRole } from "../../authz/sharing";

export const registerCollectionRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    collectionNameSchema,
    sanitizeText,
    ensureTrashCollection,
    invalidateDrawingsCache,
    collaborationAccess,
    config,
    logAuditEvent,
  } = deps;

  // GET /collections — returns owned collections + collections shared with user
  app.get(
    "/collections",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const trashCollectionId = getUserTrashCollectionId(req.user.id);
      await ensureTrashCollection(prisma, req.user.id);

      const rawCollections = await listOwnedCollections({ db: prisma, userId: req.user.id });
      const hasInternalTrash = rawCollections.some((c) => c.id === trashCollectionId);
      const sharedCollectionIds = await collectionsWithShares({
        db: prisma,
        collectionIds: rawCollections.map((c) => c.id),
      });

      const ownedCollections = rawCollections
        .filter((c) => !(hasInternalTrash && c.id === "trash"))
        .map((c) =>
          c.id === trashCollectionId
            ? {
                ...c,
                id: "trash",
                name: "Trash",
                sharedRole: null,
                isOwner: true,
                isShared: false,
              }
            : {
                ...c,
                sharedRole: null,
                isOwner: true,
                isShared: sharedCollectionIds.has(c.id),
              },
        );

      // Collections shared with this user by others.
      // Projected field by field: spreading the row handed every grantee the
      // owner's email address, which navigation never needed.
      const sharedEntries = await listCollectionsSharedWith({ db: prisma, userId: req.user.id });
      const sharedCollections = sharedEntries.map((s) => ({
        id: s.collection.id,
        name: s.collection.name,
        createdAt: s.collection.createdAt,
        updatedAt: s.collection.updatedAt,
        ownerName: s.collection.user?.name ?? null,
        sharedRole: s.role,
        isOwner: false,
        isShared: true,
      }));

      return res.json([...ownedCollections, ...sharedCollections]);
    }),
  );

  // POST /collections
  app.post(
    "/collections",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const parsed = collectionNameSchema.safeParse(req.body.name);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation error",
          message: "Collection name must be between 1 and 100 characters",
        });
      }

      const sanitizedName = sanitizeText(parsed.data, 100);
      const newCollection = await prisma.collection.create({
        data: { name: sanitizedName, userId: req.user.id },
      });
      return res.json({ ...newCollection, sharedRole: null, isOwner: true });
    }),
  );

  // PUT /collections/:id — owner only
  app.put(
    "/collections/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      if (isTrashCollectionId(id, req.user.id)) {
        return res.status(400).json({
          error: "Validation error",
          message: "Trash collection cannot be renamed",
        });
      }
      if (!(await controlsCollection({ db: prisma, userId: req.user.id, collectionId: id }))) {
        return res.status(404).json({ error: "Collection not found" });
      }

      const parsed = collectionNameSchema.safeParse(req.body.name);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation error",
          message: "Collection name must be between 1 and 100 characters",
        });
      }

      const sanitizedName = sanitizeText(parsed.data, 100);
      await renameOwnedCollection({
        db: prisma,
        userId: req.user.id,
        collectionId: id,
        name: sanitizedName,
      });
      const updated = await getOwnedCollection({
        db: prisma,
        userId: req.user.id,
        collectionId: id,
      });
      if (!updated) return res.status(404).json({ error: "Collection not found" });
      return res.json(updated);
    }),
  );

  // DELETE /collections/:id — owner only
  app.delete(
    "/collections/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      if (isTrashCollectionId(id, req.user.id)) {
        return res.status(400).json({
          error: "Validation error",
          message: "Trash collection cannot be deleted",
        });
      }
      const collection = await getOwnedCollection({
        db: prisma,
        userId: req.user.id,
        collectionId: id,
      });
      if (!collection) return res.status(404).json({ error: "Collection not found" });

      const affectedGranteeIds = await listCollectionGranteeIds({ db: prisma, collectionId: id });

      await prisma.$transaction([
        // Every board in the collection, not only the ones this account owns.
        // The rest relied on the foreign key quietly nulling the column, which
        // is a rule in the schema doing work the route should be doing.
        prisma.drawing.updateMany({
          where: { collectionId: id },
          data: { collectionId: null },
        }),
        revokeAllCollectionSharesOp({ db: prisma, collectionId: id }),
        deleteOwnedCollectionOp({ db: prisma, userId: req.user.id, collectionId: id }),
      ]);
      invalidateDrawingsCache();
      await Promise.all(
        Array.from(new Set(affectedGranteeIds)).map((userId) =>
          collaborationAccess.recheckUserAccess(userId),
        ),
      );

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "collection_deleted",
          resource: `collection:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { collectionId: id, collectionName: collection.name },
        });
      }
      return res.json({ success: true });
    }),
  );

  // ─── Collection Sharing ───────────────────────────────────────────────────

  // GET /collections/:id/shares — list shares (owner only)
  app.get(
    "/collections/:id/shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsCollection({ db: prisma, userId: req.user.id, collectionId: id }))) {
        return res.status(404).json({ error: "Collection not found" });
      }

      const shares = await listCollectionShares({ db: prisma, collectionId: id });

      return res.json({ shares });
    }),
  );

  // POST /collections/:id/shares — add or update a user share (owner only)
  app.post(
    "/collections/:id/shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const { identifier, granteeUserId, role } = req.body as {
        identifier?: string;
        granteeUserId?: string;
        role: string;
      };

      const normalizedRole = normalizeCollectionShareRole(role);
      if ((!identifier && !granteeUserId) || !normalizedRole) {
        return res
          .status(400)
          .json({ error: "granteeUserId or identifier, and role (view|edit), are required" });
      }

      if (!(await controlsCollection({ db: prisma, userId: req.user.id, collectionId: id }))) {
        return res.status(404).json({ error: "Collection not found" });
      }

      // Resolve by account id, or by a value that is unique by definition.
      // Display names are neither unique nor stable, and findFirst quietly
      // picked one of them: two colleagues called Alex meant handing a whole
      // collection to whichever row came back first.
      const grantee = granteeUserId
        ? await prisma.user.findFirst({
            where: { id: granteeUserId, isActive: true },
            select: { id: true, name: true, email: true },
          })
        : await prisma.user.findFirst({
            where: {
              isActive: true,
              OR: [{ email: (identifier || "").toLowerCase() }, { username: identifier }],
            },
            select: { id: true, name: true, email: true },
          });
      if (!grantee) return res.status(404).json({ error: "User not found" });
      if (grantee.id === req.user.id)
        return res.status(400).json({ error: "Cannot share with yourself" });

      const share = await grantCollectionShare({
        db: prisma,
        collectionId: id,
        granteeUserId: grantee.id,
        role: normalizedRole,
        grantedByUserId: req.user.id,
      });
      invalidateDrawingsCache();

      return res.json({ share });
    }),
  );

  // PATCH /collections/:id/shares/:userId — update role (owner only)
  app.patch(
    "/collections/:id/shares/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;
      const { role } = req.body as { role: string };

      const normalizedRole = normalizeCollectionShareRole(role);
      if (!normalizedRole) {
        return res.status(400).json({ error: "role must be view or edit" });
      }

      if (!(await controlsCollection({ db: prisma, userId: req.user.id, collectionId: id }))) {
        return res.status(404).json({ error: "Collection not found" });
      }

      const changed = await changeCollectionShareRole({
        db: prisma,
        collectionId: id,
        granteeUserId: userId,
        role: normalizedRole,
      });
      if (!changed) return res.status(404).json({ error: "Share not found" });
      invalidateDrawingsCache();

      return res.json({ success: true });
    }),
  );

  // DELETE /collections/:id/shares/:userId — remove a user (owner only)
  app.delete(
    "/collections/:id/shares/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;

      if (!(await controlsCollection({ db: prisma, userId: req.user.id, collectionId: id }))) {
        return res.status(404).json({ error: "Collection not found" });
      }

      const revoked = await revokeCollectionShare({
        db: prisma,
        collectionId: id,
        granteeUserId: userId,
      });
      invalidateDrawingsCache();
      if (revoked) {
        await collaborationAccess.recheckUserAccess(userId);
      }
      return res.json({ success: true });
    }),
  );

  // GET /collections/:id/share-resolve — search users to share with (owner only)
  app.get(
    "/collections/:id/share-resolve",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const q = String(req.query.q || "").trim();

      if (q.length < 2) return res.json({ users: [] });

      if (!(await controlsCollection({ db: prisma, userId: req.user.id, collectionId: id }))) {
        return res.status(404).json({ error: "Collection not found" });
      }

      // Get already-shared user IDs to exclude them
      const excludeIds = [
        req.user.id,
        ...(await listCollectionGranteeIds({ db: prisma, collectionId: id })),
      ];

      const users = await prisma.user.findMany({
        where: {
          isActive: true,
          id: { notIn: excludeIds },
          OR: [
            { email: { contains: q } },
            { name: { contains: q } },
            { username: { contains: q } },
          ],
        },
        select: { id: true, name: true, email: true },
        take: 8,
      });

      return res.json({ users });
    }),
  );
};
