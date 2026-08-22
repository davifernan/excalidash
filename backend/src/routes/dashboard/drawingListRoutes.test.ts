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
