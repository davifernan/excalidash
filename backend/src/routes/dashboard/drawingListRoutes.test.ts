import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerDrawingListRoutes } from "./drawingListRoutes";

const invoke = async (
  app: express.Express,
  user: any,
  options: { path?: "/drawings" | "/drawings/shared"; query?: Record<string, string> } = {},
) => {
  const path = options.path ?? "/drawings";
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === path && candidate.route.methods.get,
  );
  const req: any = {
    params: {},
    body: {},
    query: options.query ?? {},
    headers: {},
    connection: {},
  };
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      this.bodyBytes = Buffer.byteLength(JSON.stringify(payload));
      return this;
    },
    send(payload: Buffer | string) {
      this.bodyBytes = Buffer.byteLength(payload);
      this.payload = JSON.parse(payload.toString());
      return this;
    },
  };
  (app as any).__user = user;
  for (const handlerLayer of layer.route.stack) {
    await handlerLayer.handle(req, res, () => undefined);
  }
  return res;
};

const buildDrawing = (index: number, previewBytes = 0) => ({
  id: `drawing-${index + 1}`,
  name: `Board ${index + 1}`,
  collectionId: null,
  userId: "account-1",
  preview: previewBytes > 0 ? "p".repeat(previewBytes) : null,
  permissions: [{ permission: "view" }],
  version: 1,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  user: { id: "account-1", name: "Owner" },
  createdBy: { name: "Owner" },
});

const selectFields = (drawing: ReturnType<typeof buildDrawing>, select: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([, selection]) => Boolean(selection))
      .map(([field]) => [field, drawing[field as keyof typeof drawing]]),
  );

const buildApp = (drawings = [buildDrawing(0)]) => {
  const findMany = vi.fn(async (options: any = {}) => {
    const requestedIds = options.where?.id?.in as string[] | undefined;
    const matching = requestedIds
      ? drawings.filter((drawing) => requestedIds.includes(drawing.id))
      : drawings;
    const start = options.skip ?? 0;
    const end = options.take === undefined ? undefined : start + options.take;
    const page = matching.slice(start, end);
    return options.select ? page.map((drawing) => selectFields(drawing, options.select)) : page;
  });
  const prisma: any = {
    drawing: {
      findMany,
      count: vi.fn().mockResolvedValue(drawings.length),
    },
    drawingPermission: { findMany: vi.fn().mockResolvedValue([]) },
    drawingLinkShare: { findMany: vi.fn().mockResolvedValue([]) },
    drawingFavorite: { findMany: vi.fn().mockResolvedValue([]) },
    collection: { findMany: vi.fn().mockResolvedValue([]) },
    collectionShare: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([{ id: "account-1", name: "Owner" }]) },
  };
  const cache = new Map<string, Buffer>();
  const app = express();
  registerDrawingListRoutes(app, {
    prisma,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = (app as any).__user;
      next();
    },
    asyncHandler: (handler: any) => async (req: any, res: any, next: any) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    },
    parseJsonField: (_value: unknown, fallback: unknown) => fallback,
    subjectKeySecret: "test-secret",
    buildDrawingsCacheKey: ({ userId }: any) => `drawings:${userId}`,
    getCachedDrawingsBody: (key: string) => cache.get(key) ?? null,
    cacheDrawingsResponse: (key: string, payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload));
      cache.set(key, body);
      return body;
    },
    MAX_PAGE_SIZE: 100,
  } as any);
  return { app, prisma };
};

describe("drawing list pagination", () => {
  it("defaults owned and shared lists to 50 while preserving explicit and small-list behavior", async () => {
    const previewBytes = 100 * 1024;
    const drawings = Array.from({ length: 51 }, (_, index) => buildDrawing(index, previewBytes));
    const { app } = buildApp(drawings);
    const user = { id: "account-1", authCredentialType: "jwt" };

    const explicit = await invoke(app, user, {
      query: { includePreview: "true", limit: "7" },
    });
    const small = await invoke(buildApp(drawings.slice(0, 3)).app, user);
    const defaultOwned = await invoke(app, user, { query: { includePreview: "true" } });
    const defaultShared = await invoke(app, user, {
      path: "/drawings/shared",
      query: { includePreview: "true" },
    });

    expect(explicit.payload.drawings).toHaveLength(7);
    expect(explicit.payload.limit).toBe(7);
    expect(small.payload.drawings).toHaveLength(3);
    expect(defaultOwned.payload.drawings[0]).toMatchObject({
      creatorName: "Owner",
      preview: "p".repeat(previewBytes),
      members: { totalCount: 1 },
    });
    expect(defaultOwned.payload.limit).toBe(50);
    expect(defaultOwned.payload.drawings).toHaveLength(50);
    expect(defaultShared.payload.limit).toBe(50);
    expect(defaultShared.payload.drawings).toHaveLength(50);
    expect(defaultOwned.bodyBytes).toBeGreaterThanOrEqual(50 * previewBytes);
    expect(defaultOwned.bodyBytes).toBeLessThan(51 * previewBytes);
  });
});

describe("drawing list member projection", () => {
  it("does not expose the member roster to an API key or through its account cache", async () => {
    const { app } = buildApp();

    const browser = await invoke(app, { id: "account-1", authCredentialType: "jwt" });
    expect(browser.payload.drawings[0].members.totalCount).toBe(1);

    const apiKey = await invoke(app, { id: "account-1", authCredentialType: "apiKey" });
    expect(apiKey.statusCode).toBe(200);
    expect(apiKey.payload.drawings[0]).not.toHaveProperty("members");
  });
});

describe("drawing list provenance (NIL-290)", () => {
  it("flags an owned board with an active link share, and only that one", async () => {
    const drawings = [buildDrawing(0), buildDrawing(1)];
    const { app, prisma } = buildApp(drawings);
    prisma.drawingLinkShare.findMany = vi.fn(async ({ where }: any) =>
      [{ drawingId: "drawing-1" }].filter((row) => where.drawingId.in.includes(row.drawingId)),
    );

    const res = await invoke(app, { id: "account-1", authCredentialType: "jwt" });

    const byId = Object.fromEntries(res.payload.drawings.map((d: any) => [d.id, d]));
    expect(byId["drawing-1"].linkShared).toBe(true);
    expect(byId["drawing-2"].linkShared).toBe(false);
    expect(byId["drawing-1"].accessVia).toBeUndefined();
  });

  it("marks every board in someone else's shared collection as accessVia collection, without a linkShared exposure signal", async () => {
    const drawings = [{ ...buildDrawing(0), userId: "collection-owner" }];
    const { app, prisma } = buildApp(drawings);
    // Existence check (no userId in `where`) sees the collection; the
    // ownership check (`where.userId`) only matches its real owner -- the
    // requesting viewer ("account-1") is not it, so getCollectionAccess
    // falls through to the collectionShare grant below instead of "owner".
    prisma.collection.findFirst = vi.fn(async ({ where }: any) => {
      if (where.userId) return where.userId === "collection-owner" ? { id: "col-1" } : null;
      return where.id === "col-1" ? { id: "col-1", userId: "collection-owner" } : null;
    });
    prisma.collectionShare.findFirst = vi.fn().mockResolvedValue({ role: "view" });
    prisma.drawingLinkShare.findMany = vi.fn();

    const res = await invoke(app, { id: "account-1", authCredentialType: "jwt" }, {
      query: { collectionId: "col-1" },
    });

    expect(res.payload.drawings[0].accessVia).toBe("collection");
    expect(res.payload.drawings[0]).not.toHaveProperty("linkShared");
    expect(prisma.drawingLinkShare.findMany).not.toHaveBeenCalled();
  });

  it("marks every board on the shared-with-me list as accessVia direct", async () => {
    const { app } = buildApp();

    const res = await invoke(app, { id: "account-1", authCredentialType: "jwt" }, {
      path: "/drawings/shared",
    });

    expect(res.payload.drawings[0].accessVia).toBe("direct");
  });
});

describe("drawing list favorites (NIL-292)", () => {
  it("flags a starred board, and only that one, without filtering the list", async () => {
    const drawings = [buildDrawing(0), buildDrawing(1)];
    const { app, prisma } = buildApp(drawings);
    prisma.drawingFavorite.findMany = vi.fn(async ({ where }: any) =>
      [{ drawingId: "drawing-1" }].filter((row) => where.drawingId.in.includes(row.drawingId)),
    );

    const res = await invoke(app, { id: "account-1", authCredentialType: "jwt" });

    expect(res.payload.drawings).toHaveLength(2);
    const byId = Object.fromEntries(res.payload.drawings.map((d: any) => [d.id, d]));
    expect(byId["drawing-1"].isFavorite).toBe(true);
    expect(byId["drawing-2"].isFavorite).toBe(false);
  });

  it("does not compute isFavorite for an API key, same minimization as members", async () => {
    const { app, prisma } = buildApp();
    prisma.drawingFavorite.findMany = vi.fn();

    const res = await invoke(app, { id: "account-1", authCredentialType: "apiKey" });

    expect(res.payload.drawings[0]).not.toHaveProperty("isFavorite");
    expect(prisma.drawingFavorite.findMany).not.toHaveBeenCalled();
  });

  it("filters to only favorited boards when favoritesOnly is set", async () => {
    const drawings = [buildDrawing(0), buildDrawing(1)];
    const { app, prisma } = buildApp(drawings);
    // getDrawingMemberProjections (via getDrawingRosters) also calls
    // drawing.findMany, with an unrelated `{ id: { in: [...] } }` shape --
    // capture every call and pick out the top-level list query by its
    // `userId` filter, rather than assuming this is the only caller.
    const capturedWheres: any[] = [];
    prisma.drawing.findMany = vi.fn(async (options: any) => {
      capturedWheres.push(options.where);
      if (options.where?.userId) return drawings.filter((d) => d.id === "drawing-1");
      return drawings.filter((d) => options.where?.id?.in?.includes(d.id));
    });
    prisma.drawing.count = vi.fn().mockResolvedValue(1);
    prisma.drawingFavorite.findMany = vi.fn().mockResolvedValue([{ drawingId: "drawing-1" }]);

    const res = await invoke(app, { id: "account-1", authCredentialType: "jwt" }, {
      query: { favoritesOnly: "true" },
    });

    const listWhere = capturedWheres.find((where) => where?.userId);
    expect(listWhere.favoritedBy).toEqual({ some: { userId: "account-1" } });
    expect(res.payload.drawings).toHaveLength(1);
    expect(res.payload.drawings[0].isFavorite).toBe(true);
  });

  it("does not filter by favorites when favoritesOnly is absent", async () => {
    const { app } = buildApp();

    const res = await invoke(app, { id: "account-1", authCredentialType: "jwt" });

    expect(res.payload.drawings).toHaveLength(1);
  });
});
