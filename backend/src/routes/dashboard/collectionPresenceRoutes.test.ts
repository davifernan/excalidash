import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerCollectionPresenceRoutes } from "./collectionPresenceRoutes";
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
  ...overrides,
});

const invoke = async (app: express.Express, params: Record<string, string>, user: any) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === "/dashboard/collections/:id/presence",
  );
  const req: any = { params, body: {}, query: {}, headers: {}, connection: {}, ip: "127.0.0.1" };
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    set(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
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

// Collection "col-1" is owned by Olga and shared with Max (edit). It holds
// two boards. "col-2" is a collection Max has no claim on.
const buildApp = (presences: PresenceRegistry) => {
  const prisma: any = {
    collection: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === "col-1" ? { userId: "acct-olga" } : null,
      ),
    },
    collectionShare: {
      findMany: vi.fn(async ({ where }: any) =>
        where.collectionId === "col-1" ? [{ granteeUserId: "acct-max", role: "edit" }] : [],
      ),
    },
    user: {
      findMany: vi.fn(async ({ where }: any) =>
        [
          { id: "acct-olga", name: "Owner Olga" },
          { id: "acct-max", name: "Member Max" },
        ].filter((row) => where.id.in.includes(row.id)),
      ),
    },
    drawing: {
      findMany: vi.fn(async ({ where }: any) =>
        where.collectionId === "col-1" ? [{ id: "board-1" }, { id: "board-2" }] : [],
      ),
    },
  };
  const app = express();
  registerCollectionPresenceRoutes(app, {
    prisma,
    requireAuth: (req: any, _res: any, next: any) => next(),
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

describe("collection presence", () => {
  it("names a connected collection member with a collection-scoped key, not the drawing-scoped one", async () => {
    const presences = new PresenceRegistry();
    presences.join("board-1", entry({ presenceId: "s1", accountId: "acct-max" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { id: "col-1" }, { id: "acct-max" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.connectedMemberKeys).toHaveLength(1);
    const body = JSON.stringify(res.payload);
    expect(body).not.toContain("acct-max");
    expect(body).not.toContain("Max");
  });

  it("is not fooled by two tabs on two different boards in the same collection", async () => {
    const presences = new PresenceRegistry();
    presences.join("board-1", entry({ presenceId: "s1", accountId: "acct-max" }));
    presences.join("board-2", entry({ presenceId: "s2", accountId: "acct-max" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { id: "col-1" }, { id: "acct-max" });

    expect(res.payload.connectedMemberKeys).toHaveLength(1);
  });

  it("counts a signed-in visitor who is not a collection member as a guest, not a member", async () => {
    const presences = new PresenceRegistry();
    presences.join("board-1", entry({ presenceId: "s1", accountId: "acct-stranger" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { id: "col-1" }, { id: "acct-max" });

    expect(res.payload).toEqual({
      collectionId: "col-1",
      connectedMemberKeys: [],
      guestCount: 1,
    });
  });

  it("answers a collection the caller has no claim on like it does not exist", async () => {
    const { app } = buildApp(new PresenceRegistry());

    const res = await invoke(app, { id: "col-2" }, { id: "acct-max" });

    expect(res.statusCode).toBe(404);
  });

  it("is not an agent endpoint", async () => {
    const { app } = buildApp(new PresenceRegistry());

    const res = await invoke(
      app,
      { id: "col-1" },
      { id: "acct-max", authCredentialType: "apiKey" },
    );

    expect(res.statusCode).toBe(403);
  });
});
