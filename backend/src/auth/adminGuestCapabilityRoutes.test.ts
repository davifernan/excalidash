import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerAdminRoutes } from "./adminRoutes";

const buildApp = (options?: { role?: "ADMIN" | "USER" }) => {
  const router = express.Router();
  router.use(express.json());

  const systemConfigRow = {
    guestUploadEnabled: false,
    guestCommentVisibilityEnabled: true,
  };
  const prisma = {
    systemConfig: {
      findUnique: vi.fn().mockImplementation(async () => systemConfigRow),
      upsert: vi.fn().mockImplementation(async ({ update }: any) => {
        Object.assign(systemConfigRow, update);
        return systemConfigRow;
      }),
    },
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  } as any;

  registerAdminRoutes({
    router,
    prisma,
    requireAuth: ((req: any, _res: any, next: any) => {
      req.user = {
        id: "acting-id",
        email: "acting@test.local",
        name: "Acting",
        role: options?.role ?? "ADMIN",
      };
      next();
    }) as any,
    accountActionRateLimiter: ((_req: any, _res: any, next: any) => next()) as any,
    ensureAuthEnabled: vi.fn().mockResolvedValue(true),
    ensureSystemConfig: vi.fn().mockResolvedValue({ id: "default" }),
    parseLoginRateLimitConfig: vi.fn(),
    applyLoginRateLimitConfig: vi.fn(),
    resetLoginAttemptKey: vi.fn(),
    requireAdmin: ((req: any, res: any) => {
      if (req.user?.role === "ADMIN") return true;
      res.status(403).json({ error: "Forbidden", message: "Admin access required" });
      return false;
    }) as any,
    findUserByIdentifier: vi.fn(),
    countActiveAdmins: vi.fn().mockResolvedValue(1),
    sanitizeText: (input: unknown) => String(input ?? "").trim(),
    generateTempPassword: vi.fn(),
    generateTokens: vi.fn(),
    getRefreshTokenExpiresAt: vi.fn(),
    config: {
      authMode: "local",
      enableAuditLogging: false,
      enableRefreshTokenRotation: false,
      oidc: { enabled: false, providerName: "OIDC", jitProvisioning: true },
    },
    defaultSystemConfigId: "default",
    setAuthCookies: vi.fn(),
    requireCsrf: vi.fn().mockReturnValue(true),
  });

  const app = express();
  app.use(router);
  return { app, prisma, systemConfigRow };
};

describe("instance-wide guest capability ceiling", () => {
  it("reports the persisted instance policy", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/guest-capabilities");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      capabilities: { uploadFiles: false, viewComments: true },
    });
  });

  it("lets an admin raise the ceiling", async () => {
    const { app, systemConfigRow } = buildApp();

    const response = await request(app).put("/guest-capabilities").send({ uploadFiles: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      capabilities: { uploadFiles: true, viewComments: true },
    });
    expect(systemConfigRow.guestUploadEnabled).toBe(true);
  });

  it("refuses a non-admin, read and write alike", async () => {
    const { app } = buildApp({ role: "USER" });

    const getResponse = await request(app).get("/guest-capabilities");
    const putResponse = await request(app).put("/guest-capabilities").send({ uploadFiles: true });

    expect(getResponse.status).toBe(403);
    expect(putResponse.status).toBe(403);
  });

  it("rejects a payload naming neither capability", async () => {
    const { app } = buildApp();

    const response = await request(app).put("/guest-capabilities").send({});

    expect(response.status).toBe(400);
  });
});
