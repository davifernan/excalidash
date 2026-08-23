import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerApiKeySocketRevoker,
  registerUserSocketRechecker,
} from "../server/socketRevocation";
import { registerAdminUserRoutes } from "./adminUserRoutes";

describe("admin account deactivation", () => {
  afterEach(() => {
    registerApiKeySocketRevoker(async () => undefined);
    registerUserSocketRechecker(async () => undefined);
  });

  it("revokes stored credentials and disconnects user and API-key sockets before responding", async () => {
    const recheckUserSockets = vi.fn().mockResolvedValue(undefined);
    const disconnectApiKey = vi.fn().mockResolvedValue(undefined);
    registerUserSocketRechecker(recheckUserSockets);
    registerApiKeySocketRevoker(disconnectApiKey);

    const prisma: any = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "member",
          role: "USER",
          isActive: true,
        }),
        update: vi.fn().mockResolvedValue({
          id: "member",
          username: "member",
          email: "member@example.test",
          name: "Member",
          role: "USER",
          mustResetPassword: false,
          isActive: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      },
      refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([{ id: "member-api-key" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      drawing: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      collection: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      drawingPermission: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      drawingLinkShare: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      collectionShare: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));

    const router = express.Router();
    registerAdminUserRoutes({
      router,
      prisma,
      requireAuth: ((req: any, _res: any, next: any) => {
        req.user = { id: "admin", role: "ADMIN" };
        next();
      }) as any,
      accountActionRateLimiter: ((_req: any, _res: any, next: any) => next()) as any,
      ensureAuthEnabled: async () => true,
      requireCsrf: () => true,
      requireAdmin: () => true,
      countActiveAdmins: async () => 2,
      sanitizeText: (value: unknown) => String(value),
      config: { enableAuditLogging: false },
    } as any);
    const layer = (router as any).stack.find(
      (candidate: any) => candidate.route?.path === "/users/:id" && candidate.route.methods.patch,
    );
    const req: any = {
      params: { id: "member" },
      body: { isActive: false },
      headers: {},
      connection: {},
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
    for (const handler of layer.route.stack) {
      await handler.handle(req, res, () => undefined);
    }

    expect(res.statusCode).toBe(200);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "member", revoked: false },
      data: { revoked: true },
    });
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "member", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(recheckUserSockets).toHaveBeenCalledWith("member");
    expect(disconnectApiKey).toHaveBeenCalledWith("member-api-key");
  });

  it("reassigns the deactivated member's boards and collections to the acting admin, without stripping boards out of their collections", async () => {
    const prisma: any = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "member", role: "USER", isActive: true }),
        update: vi.fn().mockResolvedValue({
          id: "member",
          username: "member",
          email: "member@example.test",
          name: "Member",
          role: "USER",
          mustResetPassword: false,
          isActive: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      },
      refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      drawing: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
      collection: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      drawingPermission: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      drawingLinkShare: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      collectionShare: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));

    const router = express.Router();
    registerAdminUserRoutes({
      router,
      prisma,
      requireAuth: ((req: any, _res: any, next: any) => {
        req.user = { id: "acting-admin", role: "ADMIN" };
        next();
      }) as any,
      accountActionRateLimiter: ((_req: any, _res: any, next: any) => next()) as any,
      ensureAuthEnabled: async () => true,
      requireCsrf: () => true,
      requireAdmin: () => true,
      countActiveAdmins: async () => 2,
      sanitizeText: (value: unknown) => String(value),
      config: { enableAuditLogging: false },
    } as any);
    const layer = (router as any).stack.find(
      (candidate: any) => candidate.route?.path === "/users/:id" && candidate.route.methods.patch,
    );
    const req: any = {
      params: { id: "member" },
      body: { isActive: false },
      headers: {},
      connection: {},
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
    for (const handler of layer.route.stack) {
      await handler.handle(req, res, () => undefined);
    }

    expect(res.statusCode).toBe(200);
    // Boards keep their collectionId here -- only full offboarding detaches them.
    expect(prisma.drawing.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "member",
        OR: [{ collectionId: null }, { collectionId: { not: "trash:member" } }],
      },
      data: { userId: "acting-admin" },
    });
    expect(prisma.collection.updateMany).toHaveBeenCalledWith({
      where: { userId: "member", id: { not: "trash:member" } },
      data: { userId: "acting-admin" },
    });
    expect(res.payload).toMatchObject({ transferredDrawings: 3, transferredCollections: 1 });
  });

  it("excludes the departing member's own trash collection and its boards from reassignment", async () => {
    const prisma: any = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "member", role: "USER", isActive: true }),
        update: vi.fn().mockResolvedValue({
          id: "member",
          username: "member",
          email: "member@example.test",
          name: "Member",
          role: "USER",
          mustResetPassword: false,
          isActive: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      },
      refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // Two boards owned by "member": one in the trash collection, one not.
      // Only the second may be reassigned.
      drawing: {
        updateMany: vi.fn(async ({ where }: any) => {
          const trashed = { id: "d-trashed", userId: "member", collectionId: "trash:member" };
          const live = { id: "d-live", userId: "member", collectionId: "other-collection" };
          const matches = [trashed, live].filter((row) => {
            if (where.userId !== row.userId) return false;
            if (!where.OR) return true;
            return where.OR.some((clause: any) =>
              clause.collectionId === null
                ? row.collectionId === null
                : row.collectionId !== clause.collectionId.not,
            );
          });
          return { count: matches.length };
        }),
      },
      collection: {
        updateMany: vi.fn(async ({ where }: any) => {
          const rows = [
            { id: "trash:member", userId: "member" },
            { id: "c-real", userId: "member" },
          ];
          const matches = rows.filter(
            (row) => where.userId === row.userId && (!where.id || row.id !== where.id.not),
          );
          return { count: matches.length };
        }),
      },
      drawingPermission: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      drawingLinkShare: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      collectionShare: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));

    const router = express.Router();
    registerAdminUserRoutes({
      router,
      prisma,
      requireAuth: ((req: any, _res: any, next: any) => {
        req.user = { id: "acting-admin", role: "ADMIN" };
        next();
      }) as any,
      accountActionRateLimiter: ((_req: any, _res: any, next: any) => next()) as any,
      ensureAuthEnabled: async () => true,
      requireCsrf: () => true,
      requireAdmin: () => true,
      countActiveAdmins: async () => 2,
      sanitizeText: (value: unknown) => String(value),
      config: { enableAuditLogging: false },
    } as any);
    const layer = (router as any).stack.find(
      (candidate: any) => candidate.route?.path === "/users/:id" && candidate.route.methods.patch,
    );
    const req: any = {
      params: { id: "member" },
      body: { isActive: false },
      headers: {},
      connection: {},
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
    for (const handler of layer.route.stack) {
      await handler.handle(req, res, () => undefined);
    }

    expect(res.statusCode).toBe(200);
    // One board reassigned (the live one), not two -- the trashed board stayed put.
    expect(res.payload).toMatchObject({ transferredDrawings: 1, transferredCollections: 1 });
  });
});
