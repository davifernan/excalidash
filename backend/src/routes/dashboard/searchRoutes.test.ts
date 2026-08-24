/**
 * Integration tests for GET /search (NIL-362/NIL-298/NIL-363).
 *
 * Real database, not a mocked Prisma client: a mock that does not actually
 * apply a `where` filter would report green even if the route filtered
 * nothing at all, which is exactly the failure mode this package exists to
 * rule out (see the package's own "filter in the query, not the result").
 */
import express from "express";
import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPrisma, setupTestDb } from "../../__tests__/testUtils";
import { PrismaClient } from "../../generated/client";
import { registerSearchRoutes } from "./searchRoutes";

let prisma: PrismaClient;

const invoke = async (app: express.Express, userId: string, query: Record<string, string>) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === "/search" && candidate.route.methods.get,
  );
  const req: any = { params: {}, body: {}, query, headers: {}, connection: {}, user: { id: userId } };
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
  registerSearchRoutes(app, {
    prisma,
    requireAuth: (req: any, _res: any, next: any) => next(),
    asyncHandler: (handler: any) => async (req: any, res: any, next: any) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    },
    parseJsonField: (raw: string | null | undefined, fallback: unknown) => {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    MAX_PAGE_SIZE: 50,
  } as any);
  return app;
};

const textElements = (text: string) => JSON.stringify([{ id: "el-1", type: "text", text, isDeleted: false }]);

describe("GET /search", () => {
  let owner: { id: string };
  let stranger: { id: string };
  let collectionGrantee: { id: string };
  let collectionId: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const hash = await bcrypt.hash("password", 10);
    owner = await prisma.user.create({
      data: { email: "owner@search-test.com", passwordHash: hash, name: "Owner" },
    });
    stranger = await prisma.user.create({
      data: { email: "stranger@search-test.com", passwordHash: hash, name: "Stranger" },
    });
    collectionGrantee = await prisma.user.create({
      data: { email: "grantee@search-test.com", passwordHash: hash, name: "Grantee" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.collectionShare.deleteMany({});
    await prisma.drawingPermission.deleteMany({});
    await prisma.drawing.deleteMany({});
    await prisma.collection.deleteMany({});
    const collection = await prisma.collection.create({
      data: { name: "Owner's collection", userId: owner.id },
    });
    collectionId = collection.id;
  });

  it("finds the owner's own board by content, with a snippet and elementId", async () => {
    await prisma.drawing.create({
      data: {
        name: "Roadmap",
        elements: textElements("Ship the payments launch this quarter"),
        appState: "{}",
        userId: owner.id,
        searchText: "roadmap ship the payments launch this quarter",
      },
    });

    const res = await invoke(buildApp(), owner.id, { q: "payments" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.totalCount).toBe(1);
    expect(res.payload.results[0]).toMatchObject({
      name: "Roadmap",
      matchKind: "content",
      elementId: "el-1",
      accessLevel: "owner",
    });
    expect(res.payload.results[0].snippet).toContain("payments launch");
  });

  it("gives an account with no claim on the board zero results AND zero count -- not a truncated result", async () => {
    await prisma.drawing.create({
      data: {
        name: "Confidential payments plan",
        elements: textElements("Payments migration details"),
        appState: "{}",
        userId: owner.id,
        searchText: "confidential payments plan payments migration details",
      },
    });

    const res = await invoke(buildApp(), stranger.id, { q: "payments" });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ results: [], totalCount: 0, limit: 20, offset: 0 });
  });

  it("finds a board through a collection share grant, not just direct board grants", async () => {
    await prisma.collectionShare.create({
      data: {
        collectionId,
        granteeUserId: collectionGrantee.id,
        role: "view",
        createdByUserId: owner.id,
      },
    });
    await prisma.drawing.create({
      data: {
        name: "Team payments board",
        elements: "[]",
        appState: "{}",
        userId: owner.id,
        collectionId,
        searchText: "team payments board",
      },
    });

    const res = await invoke(buildApp(), collectionGrantee.id, { q: "payments" });

    expect(res.payload.totalCount).toBe(1);
    expect(res.payload.results[0].name).toBe("Team payments board");
  });

  it("excludes an archived board by default, and only that board under archivedOnly", async () => {
    await prisma.drawing.create({
      data: {
        name: "Payments active",
        elements: "[]",
        appState: "{}",
        userId: owner.id,
        searchText: "payments active",
      },
    });
    await prisma.drawing.create({
      data: {
        name: "Payments archived",
        elements: "[]",
        appState: "{}",
        userId: owner.id,
        searchText: "payments archived",
        archivedAt: new Date(),
      },
    });

    const defaultSearch = await invoke(buildApp(), owner.id, { q: "payments" });
    expect(defaultSearch.payload.totalCount).toBe(1);
    expect(defaultSearch.payload.results[0].name).toBe("Payments active");

    const archiveView = await invoke(buildApp(), owner.id, { archivedOnly: "true" });
    expect(archiveView.payload.totalCount).toBe(1);
    expect(archiveView.payload.results[0].name).toBe("Payments archived");
  });

  it("RED PROBE: a where-clause that forgets the visibility filter would leak -- proving this suite can fail", async () => {
    await prisma.drawing.create({
      data: {
        name: "Leak canary",
        elements: "[]",
        appState: "{}",
        userId: owner.id,
        searchText: "leak canary",
      },
    });

    // Simulates the exact bug class this package's exit criteria name: a
    // search that finds first and would filter after. Querying with no
    // visibility `where` at all (what the route would do if the OR clause
    // were accidentally dropped) must find the board -- confirming a
    // leaking implementation is not something this suite would silently
    // pass on every board being invisible by coincidence.
    const wouldLeak = await prisma.drawing.findMany({
      where: { searchText: { contains: "leak" } },
    });
    expect(wouldLeak).toHaveLength(1);

    // The actual route, exercised through the same stranger as above, must
    // not find it.
    const res = await invoke(buildApp(), stranger.id, { q: "leak" });
    expect(res.payload.totalCount).toBe(0);
  });
});
