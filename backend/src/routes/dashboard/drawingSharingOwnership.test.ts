import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerDrawingSharingRoutes } from "./drawingSharingRoutes";

const invoke = async (
  app: express.Express,
  method: "get" | "post" | "delete",
  path: string,
  params: Record<string, string>,
  body: Record<string, unknown> = {},
) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === path && candidate.route.methods[method],
  );
  const req: any = { params, body, query: {}, headers: {}, connection: {} };
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
  for (const handlerLayer of layer.route.stack) {
    await handlerLayer.handle(req, res, () => undefined);
  }
  return res;
};

// A board drawn by "editor" inside a collection owned by "collection-owner".
const buildApp = (actingUserId: string) => {
  const prisma: any = {
    drawing: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "drawing-1", userId: "editor", collectionId: "collection-1" }]),
    },
    drawingPermission: { findMany: vi.fn().mockResolvedValue([]) },
    collection: {
      findMany: vi.fn(async ({ where }: any) =>
        where.userId === "collection-owner" ? [{ id: "collection-1" }] : [],
      ),
    },
    collectionShare: { findMany: vi.fn().mockResolvedValue([]) },
    drawingLinkShare: { findMany: vi.fn().mockResolvedValue([]) },
    // getDrawingRosters (NIL-291: the sharing endpoint now also returns the
    // roster, not just direct grants) resolves display names for whoever
    // holds a claim -- here, "editor" (drew the board) and
    // "collection-owner" (owns the collection it lives in).
    user: {
      findMany: vi.fn().mockResolvedValue([
        { id: "editor", name: "Editor" },
        { id: "collection-owner", name: "Collection Owner" },
      ]),
    },
  };
  const app = express();
  registerDrawingSharingRoutes(app, {
    prisma,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { id: actingUserId };
      next();
    },
    asyncHandler: (handler: any) => async (req: any, res: any, next: any) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    },
    invalidateDrawingsCache: vi.fn(),
    collaborationAccess: { recheckDrawingAccess: vi.fn(), recheckUserAccess: vi.fn() },
    config: { enableAuditLogging: false },
    logAuditEvent: vi.fn(),
    resolveDefaultTtlMs: () => null,
    resolveMaxTtlMs: () => null,
  } as any);
  return { app, prisma };
};

describe("who may hand a board to someone else", () => {
  it("lets the collection owner manage a board created in their collection", async () => {
    const { app, prisma } = buildApp("collection-owner");

    const res = await invoke(app, "get", "/drawings/:id/sharing", { id: "drawing-1" });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toHaveProperty("permissions");
    expect(res.payload).toHaveProperty("linkShares");
    expect(prisma.collection.findMany).toHaveBeenCalled();
  });

  it("still hides the board from someone with no claim on it", async () => {
    const { app } = buildApp("stranger");

    const res = await invoke(app, "get", "/drawings/:id/sharing", { id: "drawing-1" });

    expect(res.statusCode).toBe(404);
  });

  it("keeps the board's own owner in control", async () => {
    const { app } = buildApp("editor");

    const res = await invoke(app, "get", "/drawings/:id/sharing", { id: "drawing-1" });

    expect(res.statusCode).toBe(200);
  });
});
