import express from "express";
import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPrisma, setupTestDb } from "../../__tests__/testUtils";
import { PrismaClient } from "../../generated/client";
import { registerLibraryRoutes } from "./library";

let prisma: PrismaClient;

const invoke = async (
  app: express.Express,
  userId: string,
  role: string,
  method: "get" | "put" | "patch" | "delete",
  path: string,
  params: Record<string, string> = {},
  body: unknown = {},
) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === path && candidate.route.methods[method],
  );
  const req: any = {
    params,
    body,
    query: {},
    headers: {},
    connection: {},
    user: { id: userId, role },
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
  registerLibraryRoutes(app, {
    prisma,
    requireAuth: (req: any, _res: any, next: any) => next(),
    asyncHandler: (handler: any) => async (req: any, res: any, next: any) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    },
  } as any);
  return app;
};

const libItem = (id: string, name = "Sticky") =>
  JSON.stringify({ id, status: "published", elements: [{ type: "rectangle" }], name });

describe("Team Library (NIL-364)", () => {
  let alice: { id: string };
  let bob: { id: string };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const hash = await bcrypt.hash("password", 10);
    alice = await prisma.user.create({
      data: { email: "alice@library-test.com", passwordHash: hash, name: "Alice" },
    });
    bob = await prisma.user.create({
      data: { email: "bob@library-test.com", passwordHash: hash, name: "Bob" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.libraryItem.deleteMany({});
  });

  it("GET /library never returns another account's personal item", async () => {
    await prisma.libraryItem.create({
      data: {
        id: "row-1",
        excalidrawItemId: "item-1",
        name: "Alice's private sketch",
        visibility: "personal",
        ownerUserId: alice.id,
        excalidrawData: libItem("item-1", "Alice's private sketch"),
      },
    });

    const res = await invoke(buildApp(), bob.id, "USER", "get", "/library");

    expect(res.payload.items).toEqual([]);
  });

  it("GET /library returns a team-visibility item to every account", async () => {
    await prisma.libraryItem.create({
      data: {
        id: "row-1",
        excalidrawItemId: "item-1",
        name: "Shared template",
        visibility: "team",
        ownerUserId: alice.id,
        excalidrawData: libItem("item-1", "Shared template"),
      },
    });

    const res = await invoke(buildApp(), bob.id, "USER", "get", "/library");

    expect(res.payload.items).toHaveLength(1);
    expect(res.payload.items[0].id).toBe("item-1");
  });

  it("PUT /library never deletes or overwrites an item owned by someone else, even when it is absent from the caller's incoming array", async () => {
    await prisma.libraryItem.create({
      data: {
        id: "row-1",
        excalidrawItemId: "team-item",
        name: "Team template",
        visibility: "team",
        ownerUserId: alice.id,
        excalidrawData: libItem("team-item", "Team template"),
      },
    });

    // Bob's local Excalidraw panel syncs an empty array -- as it would the
    // very first time he opens the editor, before GET has ever populated
    // his local panel with Alice's team item.
    const res = await invoke(buildApp(), bob.id, "USER", "put", "/library", {}, { items: [] });

    expect(res.statusCode).toBe(200);
    const stillThere = await prisma.libraryItem.findUnique({ where: { id: "row-1" } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.ownerUserId).toBe(alice.id);
    expect(stillThere?.excalidrawData).toBe(libItem("team-item", "Team template"));
  });

  it("PUT /library deletes an item the caller owns when it is removed from their panel", async () => {
    await prisma.libraryItem.create({
      data: {
        id: "row-1",
        excalidrawItemId: "mine",
        name: "Mine",
        visibility: "personal",
        ownerUserId: alice.id,
        excalidrawData: libItem("mine"),
      },
    });

    const res = await invoke(buildApp(), alice.id, "USER", "put", "/library", {}, { items: [] });

    expect(res.statusCode).toBe(200);
    const gone = await prisma.libraryItem.findUnique({ where: { id: "row-1" } });
    expect(gone).toBeNull();
  });

  it("PATCH visibility lets an owner publish a personal item to the team", async () => {
    const item = await prisma.libraryItem.create({
      data: {
        id: "row-1",
        excalidrawItemId: "item-1",
        name: "Mine",
        visibility: "personal",
        ownerUserId: alice.id,
        excalidrawData: libItem("item-1"),
      },
    });

    const res = await invoke(
      buildApp(),
      alice.id,
      "USER",
      "patch",
      "/library/items/:id",
      { id: item.id },
      { visibility: "team" },
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload.visibility).toBe("team");
    // Red-probed regression (e2e/tests/discovery-library-lifecycle.spec.ts
    // caught this live): a caller that replaces its local copy of the item
    // with this response must not lose isMine/ownerName -- a partial
    // response here previously made the item's own owner's action buttons
    // disappear from the manager UI the moment it published to the team.
    expect(res.payload).toMatchObject({
      id: item.id,
      ownerUserId: alice.id,
      ownerName: "Alice",
      isMine: true,
    });
  });

  it("PATCH refuses to let a non-owner, non-admin change someone else's personal item", async () => {
    const item = await prisma.libraryItem.create({
      data: {
        id: "row-1",
        excalidrawItemId: "item-1",
        name: "Alice's",
        visibility: "personal",
        ownerUserId: alice.id,
        excalidrawData: libItem("item-1"),
      },
    });

    const res = await invoke(
      buildApp(),
      bob.id,
      "USER",
      "patch",
      "/library/items/:id",
      { id: item.id },
      { visibility: "team" },
    );

    expect(res.statusCode).toBe(404);
    const unchanged = await prisma.libraryItem.findUnique({ where: { id: item.id } });
    expect(unchanged?.visibility).toBe("personal");
  });
});
