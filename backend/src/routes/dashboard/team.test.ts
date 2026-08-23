import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerTeamRoutes } from "./team";

const invoke = async (app: express.Express, user: any) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === "/team",
  );
  const req: any = { params: {}, body: {}, query: {}, headers: {}, connection: {} };
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
  (app as any).__user = user;
  for (const handlerLayer of layer.route.stack) {
    await handlerLayer.handle(req, res, () => undefined);
  }
  return res;
};

const buildApp = () => {
  const prisma: any = {
    team: { findUnique: vi.fn().mockResolvedValue({ id: "default", name: "Team" }) },
    user: {
      findMany: vi.fn().mockResolvedValue([
        { id: "acct-admin", name: "Owner Olga", email: "olga@example.test", role: "ADMIN" },
        { id: "acct-member", name: "Member Max", email: "max@example.test", role: "USER" },
      ]),
    },
  };
  const app = express();
  registerTeamRoutes(app, {
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
  } as any);
  return { app, prisma };
};

describe("team roster", () => {
  it("lists members with roles, marks the caller as self, and never leaks account ids or emails", async () => {
    const { app } = buildApp();

    const res = await invoke(app, { id: "acct-member" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.name).toBe("Team");
    expect(res.payload.members.map((m: any) => [m.role, m.isSelf])).toEqual([
      ["owner", false],
      ["member", true],
    ]);
    const body = JSON.stringify(res.payload);
    expect(body).not.toContain("acct-admin");
    expect(body).not.toContain("acct-member");
    expect(body).not.toContain("@");
  });

  it("gives the same account a different key than the drawing/collection roster scopes would", async () => {
    const { app } = buildApp();
    const res = await invoke(app, { id: "acct-member" });
    const selfKey = res.payload.members.find((m: any) => m.isSelf).subjectKey;
    expect(typeof selfKey).toBe("string");
    expect(selfKey.length).toBeGreaterThan(0);
  });
});
