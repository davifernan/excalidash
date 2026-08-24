import express from "express";
import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPrisma, setupTestDb } from "../../__tests__/testUtils";
import { PrismaClient } from "../../generated/client";
import { registerArchiveRoutes } from "./archiveRoutes";

let prisma: PrismaClient;

const invoke = async (
  app: express.Express,
  userId: string,
  method: "post",
  path: string,
  params: Record<string, string>,
) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === path && candidate.route.methods[method],
  );
  const req: any = {
    params,
    body: {},
    query: {},
    headers: {},
    connection: {},
    user: { id: userId },
  };
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

const buildApp = () => {
  const app = express();
  registerArchiveRoutes(app, {
    prisma,
    requireAuth: (req: any, _res: any, next: any) => next(),
    asyncHandler: (handler: any) => async (req: any, res: any, next: any) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    },
    invalidateDrawingsCache: () => undefined,
  } as any);
  return app;
};

describe("archive lifecycle (NIL-365)", () => {
  let owner: { id: string };
  let editor: { id: string };
  let drawingId: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const hash = await bcrypt.hash("password", 10);
    owner = await prisma.user.create({
      data: { email: "archive-owner@test.com", passwordHash: hash, name: "Owner" },
    });
    editor = await prisma.user.create({
      data: { email: "archive-editor@test.com", passwordHash: hash, name: "Editor" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.drawingPermission.deleteMany({});
    await prisma.drawing.deleteMany({});
    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", userId: owner.id },
    });
    drawingId = drawing.id;
  });

  it("lets the controlling owner archive and restore", async () => {
    const app = buildApp();

    const archived = await invoke(app, owner.id, "post", "/drawings/:id/archive", {
      id: drawingId,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.payload.archivedAt).not.toBeNull();

    const row = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    expect(row.archivedAt).not.toBeNull();

    const restored = await invoke(app, owner.id, "post", "/drawings/:id/restore", {
      id: drawingId,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.payload.archivedAt).toBeNull();
  });

  it("refuses to archive for an account with edit access but no ownership -- lifecycle is not the same right as editing", async () => {
    await prisma.drawingPermission.create({
      data: { drawingId, granteeUserId: editor.id, permission: "edit", createdByUserId: owner.id },
    });

    const res = await invoke(buildApp(), editor.id, "post", "/drawings/:id/archive", {
      id: drawingId,
    });

    expect(res.statusCode).toBe(404);
    const row = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    expect(row.archivedAt).toBeNull();
  });
});
