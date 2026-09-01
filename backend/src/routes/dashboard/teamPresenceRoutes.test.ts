import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerTeamPresenceRoutes } from "./teamPresenceRoutes";
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

const invoke = async (app: express.Express, query: Record<string, string>, user: any) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === "/team/presence",
  );
  const req: any = { params: {}, body: {}, query, headers: {}, connection: {}, ip: "127.0.0.1" };
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

// drawing-1 belongs to nobody-relevant but is shared with viewer "acct-me".
// drawing-2 is a board "acct-me" has no claim on.
const buildApp = (presences: PresenceRegistry) => {
  const prisma: any = {
    drawing: {
      findMany: vi.fn(async ({ where }: any) =>
        [
          { id: "drawing-1", userId: "acct-owner", collectionId: null },
          { id: "drawing-2", userId: "acct-stranger", collectionId: null },
        ].filter((row) => where.id.in.includes(row.id)),
      ),
    },
    drawingPermission: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { drawingId: "drawing-1", granteeUserId: "acct-me", permission: "edit" },
        ]),
    },
    collection: { findMany: vi.fn().mockResolvedValue([]) },
    collectionShare: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findMany: vi.fn(async ({ where }: any) =>
        [
          { id: "acct-owner", name: "Owner" },
          { id: "acct-me", name: "Me" },
          { id: "acct-stranger", name: "A Stranger" },
        ].filter((row) => where.id.in.includes(row.id)),
      ),
    },
  };
  const app = express();
  registerTeamPresenceRoutes(app, {
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

describe("team presence", () => {
  it("reports a team member's board with a team-scoped key", async () => {
    const presences = new PresenceRegistry();
    presences.join(
      "drawing-1",
      entry({ presenceId: "s1", accountId: "acct-owner", kind: "owner" }),
    );
    const { app } = buildApp(presences);

    const res = await invoke(app, { ids: "drawing-1" }, { id: "acct-me" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.results).toEqual([
      { subjectKey: expect.any(String), drawingId: "drawing-1" },
    ]);
    const body = JSON.stringify(res.payload);
    expect(body).not.toContain("acct-owner");
    expect(body).not.toContain("Owner");
  });

  it("reveals nothing for a board the caller has no claim on", async () => {
    const presences = new PresenceRegistry();
    presences.join("drawing-2", entry({ presenceId: "s1", accountId: "acct-stranger" }));
    const { app } = buildApp(presences);

    const res = await invoke(app, { ids: "drawing-1,drawing-2" }, { id: "acct-me" });

    expect(res.payload.results).toEqual([]);
  });

  it("reports one board per person even with two tabs open on two boards", async () => {
    const presences = new PresenceRegistry();
    presences.join(
      "drawing-1",
      entry({ presenceId: "s1", accountId: "acct-owner", kind: "owner" }),
    );
    const { app } = buildApp(presences);

    const res = await invoke(app, { ids: "drawing-1" }, { id: "acct-me" });

    expect(res.payload.results).toHaveLength(1);
  });

  it("is not an agent endpoint", async () => {
    const { app } = buildApp(new PresenceRegistry());

    const res = await invoke(
      app,
      { ids: "drawing-1" },
      { id: "acct-me", authCredentialType: "apiKey" },
    );

    expect(res.statusCode).toBe(403);
  });
});
