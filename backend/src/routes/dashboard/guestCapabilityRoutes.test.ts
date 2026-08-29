import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerGuestCapabilityRoutes } from "./guestCapabilityRoutes";

const invoke = async (
  app: express.Express,
  method: "get" | "put",
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

// A board owned by "owner". "editor" only has a direct "edit" grant, which is
// enough to use the board but not enough to control its guest policy.
const buildApp = (actingUserId: string, options?: { instanceUploadEnabled?: boolean }) => {
  const drawingRow = {
    guestUploadEnabled: false,
    guestCommentVisibilityEnabled: true,
    guestAgentContextContributeEnabled: false,
  };
  const prisma: any = {
    drawing: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "drawing-1", userId: "owner", collectionId: null }]),
      findUnique: vi.fn().mockResolvedValue(drawingRow),
      update: vi.fn().mockImplementation(async ({ data }: any) => {
        Object.assign(drawingRow, data);
        return drawingRow;
      }),
    },
    drawingPermission: {
      findMany: vi.fn().mockResolvedValue([{ drawingId: "drawing-1", permission: "edit" }]),
    },
    collection: { findMany: vi.fn().mockResolvedValue([]) },
    collectionShare: { findMany: vi.fn().mockResolvedValue([]) },
    systemConfig: {
      findUnique: vi.fn().mockResolvedValue({
        guestUploadEnabled: options?.instanceUploadEnabled ?? true,
        guestCommentVisibilityEnabled: true,
      }),
    },
  };
  const app = express();
  registerGuestCapabilityRoutes(app, {
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
    config: { enableAuditLogging: false },
    logAuditEvent: vi.fn(),
  } as any);
  return { app, prisma, drawingRow };
};

describe("board guest capability settings", () => {
  it("lets the board owner read the board and instance policy", async () => {
    const { app } = buildApp("owner");

    const res = await invoke(app, "get", "/drawings/:id/guest-capabilities", { id: "drawing-1" });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      board: { uploadFiles: false, viewComments: true, agentContextContribute: false },
      instance: { uploadFiles: true, viewComments: true, agentContextContribute: false },
      effective: { uploadFiles: false, viewComments: true, agentContextContribute: false },
    });
  });

  it("hides the settings from someone with no claim on the board", async () => {
    const { app } = buildApp("stranger");

    const res = await invoke(app, "get", "/drawings/:id/guest-capabilities", { id: "drawing-1" });

    expect(res.statusCode).toBe(404);
  });

  it("refuses a plain editor -- an editor grant is not the same as controlling the board", async () => {
    const { app } = buildApp("editor");

    const res = await invoke(
      app,
      "put",
      "/drawings/:id/guest-capabilities",
      { id: "drawing-1" },
      {
        uploadFiles: true,
      },
    );

    expect(res.statusCode).toBe(404);
  });

  it("lets the owner turn guest uploads on when the instance ceiling allows it", async () => {
    const { app, drawingRow } = buildApp("owner");

    const res = await invoke(
      app,
      "put",
      "/drawings/:id/guest-capabilities",
      { id: "drawing-1" },
      { uploadFiles: true },
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      board: { uploadFiles: true, viewComments: true, agentContextContribute: false },
      instance: { uploadFiles: true, viewComments: true, agentContextContribute: false },
      effective: { uploadFiles: true, viewComments: true, agentContextContribute: false },
    });
    expect(drawingRow.guestUploadEnabled).toBe(true);
  });

  it("reports the board's own opt-in truthfully even while the instance ceiling is closed", async () => {
    const { app } = buildApp("owner", { instanceUploadEnabled: false });

    const res = await invoke(
      app,
      "put",
      "/drawings/:id/guest-capabilities",
      { id: "drawing-1" },
      { uploadFiles: true },
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      board: { uploadFiles: true, viewComments: true, agentContextContribute: false },
      instance: { uploadFiles: false, viewComments: true, agentContextContribute: false },
      // The instance closes it even though the board itself opted in -- this
      // is the AND semantics the UI has to display, not silently drop.
      effective: { uploadFiles: false, viewComments: true, agentContextContribute: false },
    });
  });

  it("rejects an empty update instead of silently no-opping", async () => {
    const { app } = buildApp("owner");

    const res = await invoke(
      app,
      "put",
      "/drawings/:id/guest-capabilities",
      { id: "drawing-1" },
      {},
    );

    expect(res.statusCode).toBe(400);
  });
});
