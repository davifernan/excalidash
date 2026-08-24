import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerFavoriteRoutes } from "./favoriteRoutes";

const mockGetDrawingAccess = vi.fn();
vi.mock("../../authz/sharing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../authz/sharing")>();
  return { ...actual, getDrawingAccess: (...args: unknown[]) => mockGetDrawingAccess(...args) };
});

const invoke = async (
  app: express.Express,
  method: "put" | "delete",
  user: any,
) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === "/drawings/:id/favorite" && candidate.route.methods[method],
  );
  const req: any = { params: { id: "drawing-1" }, body: {}, query: {}, headers: {}, connection: {} };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  req.user = user;
  for (const handlerLayer of layer.route.stack) {
    await handlerLayer.handle(req, res, () => undefined);
  }
  return res;
};

const buildApp = () => {
  const upsert = vi.fn().mockResolvedValue({});
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const invalidateDrawingsCache = vi.fn();
  const prisma: any = { drawingFavorite: { upsert, deleteMany } };
  const app = express();
  registerFavoriteRoutes(app, {
    prisma,
    requireAuth: (req: any, _res: any, next: any) => next(),
    asyncHandler: (handler: any) => async (req: any, res: any, next: any) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    },
    getRequestPrincipal: async (req: any) => ({ kind: "user", userId: req.user.id }),
    invalidateDrawingsCache,
  } as any);
  return { app, prisma, invalidateDrawingsCache, upsert, deleteMany };
};

describe("favorite routes (NIL-292)", () => {
  it("stars a board the caller can view", async () => {
    mockGetDrawingAccess.mockResolvedValue("view");
    const { app, upsert, invalidateDrawingsCache } = buildApp();

    const res = await invoke(app, "put", { id: "account-1" });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ isFavorite: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_drawingId: { userId: "account-1", drawingId: "drawing-1" } },
      }),
    );
    expect(invalidateDrawingsCache).toHaveBeenCalled();
  });

  it("unstars a board the caller can view", async () => {
    mockGetDrawingAccess.mockResolvedValue("edit");
    const { app, deleteMany, invalidateDrawingsCache } = buildApp();

    const res = await invoke(app, "delete", { id: "account-1" });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ isFavorite: false });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: "account-1", drawingId: "drawing-1" },
    });
    expect(invalidateDrawingsCache).toHaveBeenCalled();
  });

  it("refuses to star a board the caller cannot see, and does not write anything", async () => {
    mockGetDrawingAccess.mockResolvedValue("none");
    const { app, upsert } = buildApp();

    const res = await invoke(app, "put", { id: "account-1" });

    expect(res.statusCode).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
  });
});
