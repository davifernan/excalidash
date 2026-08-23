import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerTeamRoutes, TEAM_SUBJECT_SCOPE } from "./team";
import { subjectKey } from "../../authz/subjectKey";

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

  it('scopes the subjectKey to "team", distinct from drawing/collection roster scopes for the same account', async () => {
    const { app } = buildApp();
    const res = await invoke(app, { id: "acct-member" });
    const selfKey = res.payload.members.find((m: any) => m.isSelf).subjectKey;

    // Recomputed from the actual scope constant and the same secret/userId,
    // not merely typeof/length-checked: this fails the moment
    // TEAM_SUBJECT_SCOPE collides with another scope string, which a
    // presence check on the key alone cannot detect.
    expect(selfKey).toBe(subjectKey("test-secret", TEAM_SUBJECT_SCOPE, "acct-member"));
    expect(selfKey).not.toBe(subjectKey("test-secret", "drawing:some-board", "acct-member"));
    expect(selfKey).not.toBe(subjectKey("test-secret", "collection:some-folder", "acct-member"));
  });
});
