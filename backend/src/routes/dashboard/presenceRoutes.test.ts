import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerPresenceRoutes } from "./presenceRoutes";
import { PresenceRegistry, type PresenceEntry } from "../../server/presenceRegistry";

const entry = (overrides: Partial<PresenceEntry>): PresenceEntry => ({
  presenceId: "s1",
  accountId: "acct-max",
  name: "Member Max",
  initials: "MM",
  color: "#3b82f6",
  kind: "member",
  isActive: true,
  selectedElementIds: {},
  actor: "human",
  ...overrides,
});

const invoke = async (
  app: express.Express,
  query: Record<string, string>,
  user: any,
  ip = "127.0.0.1",
) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === "/dashboard/presence",
  );
  const req: any = { params: {}, body: {}, query, headers: {}, connection: {}, ip };
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    set(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    getHeader() {
      return undefined;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  (app as any).__user = user;
  for (const handlerLayer of layer.route.stack) {
    await handlerLayer.handle(req, res, () => undefined);
  }
  return res;
};

// drawing-1 belongs to Olga and is shared with Max. drawing-2 belongs to nobody
// the caller knows.
const buildApp = (presences: PresenceRegistry) => {
  const prisma: any = {
    drawing: {
      findMany: vi.fn(async ({ where }: any) =>
        [
          { id: "drawing-1", userId: "acct-olga", collectionId: null },
          { id: "drawing-2", userId: "acct-stranger", collectionId: null },
        ].filter((row) => where.id.in.includes(row.id)),
      ),
    },
    drawingPermission: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { drawingId: "drawing-1", granteeUserId: "acct-max", permission: "edit" },
        ]),
    },
    collection: { findMany: vi.fn().mockResolvedValue([]) },
    collectionShare: { findMany: vi.fn().mockResolvedValue([]) },
    drawingLinkShare: { findMany: vi.fn(), findFirst: vi.fn() },
    user: {
      findMany: vi.fn(async ({ where }: any) =>
        [
          { id: "acct-olga", name: "Owner Olga" },
          { id: "acct-max", name: "Member Max" },
          { id: "acct-stranger", name: "A Stranger" },
        ].filter((row) => where.id.in.includes(row.id)),
      ),
    },
  };
  const app = express();
  registerPresenceRoutes(app, {
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
    subjectKeySecret: "test-secret",
    presences,
  } as any);
  return { app, prisma };
};

describe("dashboard presence", () => {
  it("names connected members with the key the card carries, and nothing else", async () => {
    const presences = new PresenceRegistry();
    presences.join("drawing-1", entry({ presenceId: "s1", accountId: "acct-olga", kind: "owner" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { ids: "drawing-1" }, { id: "acct-max" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.results[0].connectedMemberKeys).toHaveLength(1);
    const body = JSON.stringify(res.payload);
    expect(body).not.toContain("acct-olga");
    expect(body).not.toContain("Olga");
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("answers a board the caller has no claim on like an empty one", async () => {
    const presences = new PresenceRegistry();
    presences.join("drawing-2", entry({ presenceId: "s9", accountId: "acct-stranger" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { ids: "drawing-1,drawing-2" }, { id: "acct-max" });

    expect(res.payload.results).toEqual([
      { drawingId: "drawing-1", connectedMemberKeys: [], guestCount: 0 },
      { drawingId: "drawing-2", connectedMemberKeys: [], guestCount: 0 },
    ]);
  });

  it("counts a signed-in visitor who is only here through a link as a guest", async () => {
    const presences = new PresenceRegistry();
    presences.join(
      "drawing-1",
      entry({ presenceId: "s2", accountId: "acct-link", kind: "member" }),
    );
    presences.join("drawing-1", entry({ presenceId: "s3", accountId: null, kind: "guest" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { ids: "drawing-1" }, { id: "acct-max" });

    expect(res.payload.results[0]).toEqual({
      drawingId: "drawing-1",
      connectedMemberKeys: [],
      guestCount: 2,
    });
  });

  it("collapses one person's tabs into one key", async () => {
    const presences = new PresenceRegistry();
    presences.join("drawing-1", entry({ presenceId: "s1", accountId: "acct-max" }));
    presences.join("drawing-1", entry({ presenceId: "s2", accountId: "acct-max" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { ids: "drawing-1" }, { id: "acct-max" });

    expect(res.payload.results[0].connectedMemberKeys).toHaveLength(1);
  });

  it("refuses a list that is too long to be a screen", async () => {
    const { app } = buildApp(new PresenceRegistry());
    const ids = Array.from({ length: 51 }, (_, index) => `d${index}`).join(",");

    const res = await invoke(app, { ids }, { id: "acct-max" });

    expect(res.statusCode).toBe(400);
  });

  it("is not an agent endpoint", async () => {
    const { app } = buildApp(new PresenceRegistry());

    const res = await invoke(
      app,
      { ids: "drawing-1" },
      { id: "acct-max", authCredentialType: "apiKey" },
    );

    expect(res.statusCode).toBe(403);
  });

  it("gives different auth-disabled clients independent rate-limit budgets", async () => {
    const { app } = buildApp(new PresenceRegistry());
    const bootstrap = { id: "bootstrap-admin", authCredentialType: "bootstrap" };

    for (let request = 0; request < 60; request += 1) {
      expect((await invoke(app, { ids: "drawing-1" }, bootstrap, "192.0.2.10")).statusCode).toBe(
        200,
      );
    }
    expect((await invoke(app, { ids: "drawing-1" }, bootstrap, "192.0.2.10")).statusCode).toBe(429);

    expect((await invoke(app, { ids: "drawing-1" }, bootstrap, "198.51.100.20")).statusCode).toBe(
      200,
    );
  });
});
