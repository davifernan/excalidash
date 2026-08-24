import express from "express";
import { v4 as uuidv4 } from "uuid";
import { DashboardRouteDeps } from "./types";
import { teamRoleFromUserRole } from "../../authz/team";

/**
 * NIL-364: the Team Library, replacing the flat per-account
 * `Library { id: "user_<userId>", items }` blob.
 *
 * Two surfaces read and write the same `LibraryItem` rows:
 *
 * 1. `GET/PUT /library` -- the sync contract Excalidraw's own uncontrolled
 *    library panel already expects (`api.getLibrary()`/`api.updateLibrary()`
 *    via the adapter, wired in `useEditorSceneLoader.ts` /
 *    `useEditorPersistence.ts`). Excalidraw always sends its *complete*
 *    current panel contents on every change, so `PUT` has to diff that
 *    whole-array snapshot against the database rather than replace
 *    wholesale -- replacing wholesale would let one account's local PUT
 *    delete every teammate's team-visible item the instant that account's
 *    panel did not happen to hold a copy of it. The diff below only ever
 *    creates/updates/deletes rows this account owns; a row owned by anyone
 *    else is read (so it shows up in the panel) but never written by
 *    someone else's sync, in either direction -- that is also the
 *    mechanism behind NIL-364's "item is not lost after offboarding":
 *    nothing about a normal sync can delete another account's item, so an
 *    offboarding member's *team*-visibility items simply keep existing,
 *    owned by them until `transferOwnedLibraryItems` (userOffboarding.ts)
 *    reassigns them like every other owned resource.
 * 2. `GET/PATCH/DELETE /library/items[...]` -- the dedicated Team Library
 *    manager (name, category, visibility, import/export), independent of
 *    whatever happens to be in any one account's local Excalidraw panel
 *    right now.
 *
 * `visibility: "personal"` is the "nicht sichtbare Teamitems leaken nicht"
 * acceptance line in practice: every read below filters to `"team"` items
 * plus the caller's own `"personal"` items, never anyone else's personal
 * ones.
 */

const MAX_IMPORT_ITEMS = 200;
const MAX_ITEM_DATA_LENGTH = 200_000;

type StoredExcalidrawItem = Record<string, unknown> & { id?: unknown; name?: unknown };

const parseExcalidrawItem = (raw: string): StoredExcalidrawItem => {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredExcalidrawItem) : {};
  } catch {
    return {};
  }
};

const toExcalidrawItem = (row: {
  excalidrawItemId: string;
  name: string;
  excalidrawData: string;
}): StoredExcalidrawItem => ({
  ...parseExcalidrawItem(row.excalidrawData),
  id: row.excalidrawItemId,
  name: row.name,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extractIncomingItems = (body: unknown): StoredExcalidrawItem[] => {
  const items = isPlainObject(body) ? (body as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  return items.filter(isPlainObject) as StoredExcalidrawItem[];
};

const isTeamManager = (role: string): boolean => teamRoleFromUserRole(role) === "owner";

export const registerLibraryRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  const { prisma, requireAuth, asyncHandler } = deps;

  const visibleToMe = (userId: string) => ({
    OR: [{ visibility: "team" }, { visibility: "personal", ownerUserId: userId }],
  });

  // --- Excalidraw's own native library panel sync -------------------------

  app.get(
    "/library",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const rows = await prisma.libraryItem.findMany({
        where: visibleToMe(req.user.id),
        orderBy: { createdAt: "asc" },
        select: { excalidrawItemId: true, name: true, excalidrawData: true },
      });

      return res.json({ items: rows.map(toExcalidrawItem) });
    }),
  );

  app.put(
    "/library",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const userId = req.user.id;

      const incoming = extractIncomingItems(req.body);
      if (!Array.isArray((req.body as { items?: unknown })?.items)) {
        return res.status(400).json({ error: "Items must be an array" });
      }

      const incomingById = new Map<string, StoredExcalidrawItem>();
      for (const item of incoming) {
        const itemId = typeof item.id === "string" ? item.id : null;
        if (itemId) incomingById.set(itemId, item);
      }

      const [existingForIncoming, myRows] = await Promise.all([
        incomingById.size > 0
          ? prisma.libraryItem.findMany({
              where: { excalidrawItemId: { in: [...incomingById.keys()] } },
              select: { id: true, excalidrawItemId: true, ownerUserId: true },
            })
          : Promise.resolve([]),
        prisma.libraryItem.findMany({
          where: { ownerUserId: userId },
          select: { id: true, excalidrawItemId: true },
        }),
      ]);
      const existingByItemId = new Map(
        existingForIncoming.map((row) => [row.excalidrawItemId, row]),
      );
      const myRowByItemId = new Map(myRows.map((row) => [row.excalidrawItemId, row]));

      const toCreate: {
        id: string;
        excalidrawItemId: string;
        name: string;
        excalidrawData: string;
      }[] = [];
      const toUpdate: { id: string; name: string; excalidrawData: string }[] = [];

      for (const [itemId, item] of incomingById) {
        const existing = existingByItemId.get(itemId);
        const name =
          typeof item.name === "string" && item.name.trim() ? item.name : "Untitled item";
        const excalidrawData = JSON.stringify(item);
        if (excalidrawData.length > MAX_ITEM_DATA_LENGTH) continue;

        if (!existing) {
          toCreate.push({ id: uuidv4(), excalidrawItemId: itemId, name, excalidrawData });
        } else if (existing.ownerUserId === userId) {
          // Owned by me: refresh the element data, but never overwrite a
          // name the Team Library manager already gave this item -- that
          // metadata lives independently of what the panel happens to send.
          toUpdate.push({ id: existing.id, name, excalidrawData });
        }
        // Owned by someone else (a team item): present in my panel because
        // GET already merged it in, but this sync never writes it.
      }

      const toDeleteIds = myRows
        .filter((row) => !incomingById.has(row.excalidrawItemId))
        .map((row) => row.id);

      await prisma.$transaction([
        ...toCreate.map((row) =>
          prisma.libraryItem.create({
            data: {
              id: row.id,
              excalidrawItemId: row.excalidrawItemId,
              name: row.name,
              visibility: "personal",
              ownerUserId: userId,
              excalidrawData: row.excalidrawData,
            },
          }),
        ),
        ...toUpdate.map((row) =>
          prisma.libraryItem.update({
            where: { id: row.id },
            data: { excalidrawData: row.excalidrawData },
          }),
        ),
        ...(toDeleteIds.length > 0
          ? [prisma.libraryItem.deleteMany({ where: { id: { in: toDeleteIds } } })]
          : []),
      ]);

      const rows = await prisma.libraryItem.findMany({
        where: visibleToMe(userId),
        orderBy: { createdAt: "asc" },
        select: { excalidrawItemId: true, name: true, excalidrawData: true },
      });
      return res.json({ items: rows.map(toExcalidrawItem) });
    }),
  );

  // --- Team Library manager -------------------------------------------------

  app.get(
    "/library/items",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const rows = await prisma.libraryItem.findMany({
        where: visibleToMe(req.user.id),
        orderBy: [{ visibility: "desc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          name: true,
          category: true,
          visibility: true,
          ownerUserId: true,
          owner: { select: { name: true } },
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.json({
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          category: row.category,
          visibility: row.visibility,
          ownerUserId: row.ownerUserId,
          ownerName: row.owner.name,
          isMine: row.ownerUserId === req.user!.id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      });
    }),
  );

  const canManageItem = async (userId: string, role: string, itemId: string): Promise<boolean> => {
    if (isTeamManager(role)) {
      // Even an admin only manages items already visible to them -- this is
      // team governance, not a bypass of the personal/team visibility split.
      const item = await prisma.libraryItem.findFirst({
        where: { id: itemId, ...visibleToMe(userId) },
        select: { id: true },
      });
      return item !== null;
    }
    const owned = await prisma.libraryItem.findFirst({
      where: { id: itemId, ownerUserId: userId },
      select: { id: true },
    });
    return owned !== null;
  };

  app.patch(
    "/library/items/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await canManageItem(req.user.id, req.user.role, id))) {
        return res.status(404).json({ error: "Library item not found" });
      }

      const { name, category, visibility } = req.body ?? {};
      const data: { name?: string; category?: string | null; visibility?: string } = {};
      if (typeof name === "string" && name.trim().length > 0) data.name = name.trim().slice(0, 200);
      if (category === null || typeof category === "string") {
        data.category = typeof category === "string" ? category.trim().slice(0, 100) || null : null;
      }
      if (visibility === "personal" || visibility === "team") data.visibility = visibility;

      const updated = await prisma.libraryItem.update({
        where: { id },
        data,
        include: { owner: { select: { name: true } } },
      });
      // Full row, matching GET /library/items -- a caller that replaces its
      // local copy with this response (the manager UI does, to reflect a
      // rename/category/visibility change immediately) must not lose
      // `ownerUserId`/`ownerName`/`isMine` in the process. A partial
      // response here previously did exactly that: publishing an item to
      // the team made its own owner's action buttons disappear, because
      // `isMine` silently became `undefined`.
      return res.json({
        id: updated.id,
        name: updated.name,
        category: updated.category,
        visibility: updated.visibility,
        ownerUserId: updated.ownerUserId,
        ownerName: updated.owner.name,
        isMine: updated.ownerUserId === req.user.id,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    }),
  );

  app.delete(
    "/library/items/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await canManageItem(req.user.id, req.user.role, id))) {
        return res.status(404).json({ error: "Library item not found" });
      }

      await prisma.libraryItem.delete({ where: { id } });
      return res.json({ success: true });
    }),
  );

  // --- Import / export ------------------------------------------------------

  app.get(
    "/library/export",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const rows = await prisma.libraryItem.findMany({
        where: visibleToMe(req.user.id),
        orderBy: { createdAt: "asc" },
        select: { excalidrawItemId: true, name: true, excalidrawData: true },
      });

      return res.json({
        type: "excalidrawlib",
        version: 2,
        source: "excalidash-team-library",
        libraryItems: rows.map(toExcalidrawItem),
      });
    }),
  );

  app.post(
    "/library/import",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const body = req.body as { libraryItems?: unknown; items?: unknown };
      const rawItems = Array.isArray(body?.libraryItems)
        ? body.libraryItems
        : Array.isArray(body?.items)
          ? body.items
          : null;
      if (!rawItems) {
        return res.status(400).json({
          error: "Validation error",
          message: "Expected an .excalidrawlib file: { libraryItems: [...] }",
        });
      }
      if (rawItems.length === 0) {
        return res.json({ imported: 0 });
      }
      if (rawItems.length > MAX_IMPORT_ITEMS) {
        return res.status(400).json({
          error: "Validation error",
          message: `Cannot import more than ${MAX_IMPORT_ITEMS} items at once`,
        });
      }

      const existing = await prisma.libraryItem.findMany({
        where: { ownerUserId: req.user.id },
        select: { excalidrawItemId: true },
      });
      const existingIds = new Set(existing.map((row) => row.excalidrawItemId));

      const rows: { id: string; excalidrawItemId: string; name: string; excalidrawData: string }[] =
        [];
      for (const raw of rawItems) {
        if (!isPlainObject(raw)) continue;
        if (!Array.isArray((raw as { elements?: unknown }).elements)) continue;
        const serialized = JSON.stringify(raw);
        if (serialized.length > MAX_ITEM_DATA_LENGTH) continue;
        // A re-imported id from someone else's export must not collide with
        // an id already in this account's own library.
        const itemId = typeof raw.id === "string" && !existingIds.has(raw.id) ? raw.id : uuidv4();
        existingIds.add(itemId);
        const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : "Imported item";
        rows.push({ id: uuidv4(), excalidrawItemId: itemId, name, excalidrawData: serialized });
      }

      if (rows.length === 0) {
        return res.status(400).json({
          error: "Validation error",
          message: "No valid library items found in the uploaded file",
        });
      }

      await prisma.libraryItem.createMany({
        data: rows.map((row) => ({
          id: row.id,
          excalidrawItemId: row.excalidrawItemId,
          name: row.name,
          visibility: "personal",
          ownerUserId: req.user!.id,
          excalidrawData: row.excalidrawData,
        })),
      });

      return res.json({ imported: rows.length });
    }),
  );
};
