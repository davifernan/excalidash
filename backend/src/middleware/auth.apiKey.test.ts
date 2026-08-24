import type { NextFunction } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  DRAWINGS_HISTORY_SCOPE,
  DRAWINGS_WRITE_SCOPE,
  generateApiKey,
  serializeApiKeyScopes,
} from "../auth/apiKeys";
import { createAuthMiddleware } from "./auth";
import { createDeps, createRequest, createResponse } from "./authTestHelpers";

const authenticateApiKeyRequest = async (
  scopes?: readonly string[],
  request = {
    method: "POST",
    originalUrl: "/drawings/drawing-1/history/snapshot-1/restore",
  },
) => {
  const { prisma, authModeService } = createDeps();
  authModeService.getAuthEnabled.mockResolvedValue(true);
  const generated = generateApiKey();
  prisma.apiKey.findUnique.mockResolvedValue({
    id: "api-key-1",
    tokenHash: generated.tokenHash,
    scopes: serializeApiKeyScopes(scopes),
    revokedAt: null,
    user: {
      id: "user-1",
      username: "user1",
      email: "user-1@test.local",
      name: "User One",
      role: "USER",
      mustResetPassword: false,
      isActive: true,
    },
  });
  prisma.apiKey.update.mockResolvedValue({});
  const { optionalAuth } = createAuthMiddleware({ prisma, authModeService });
  const req = createRequest({
    ...request,
    headers: { authorization: `Bearer ${generated.token}` },
  });
  const res = createResponse();
  const next = vi.fn() as NextFunction;
  await optionalAuth(req, res, next);
  return { req, res, next };
};

describe("auth middleware API key authentication", () => {
  it("attaches active user for valid API key", async () => {
    const { prisma, authModeService } = createDeps();
    authModeService.getAuthEnabled.mockResolvedValue(true);
    const generated = generateApiKey();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "api-key-1",
      tokenHash: generated.tokenHash,
      scopes: serializeApiKeyScopes(),
      revokedAt: null,
      user: {
        id: "user-1",
        username: "user1",
        email: "user-1@test.local",
        name: "User One",
        role: "USER",
        mustResetPassword: false,
        isActive: true,
      },
    });
    prisma.apiKey.update.mockResolvedValue({});
    const { requireAuth } = createAuthMiddleware({ prisma, authModeService });
    const req = createRequest({
      headers: {
        authorization: `Bearer ${generated.token}`,
      },
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({
      id: "user-1",
      email: "user-1@test.local",
      authCredentialType: "apiKey",
    });
    expect(req.principal).toEqual({ kind: "user", userId: "user-1" });
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: "api-key-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("allows valid API key auth when lastUsedAt update fails", async () => {
    const { prisma, authModeService } = createDeps();
    authModeService.getAuthEnabled.mockResolvedValue(true);
    const generated = generateApiKey();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "api-key-1",
      tokenHash: generated.tokenHash,
      scopes: serializeApiKeyScopes(),
      revokedAt: null,
      user: {
        id: "user-1",
        username: "user1",
        email: "user-1@test.local",
        name: "User One",
        role: "USER",
        mustResetPassword: false,
        isActive: true,
      },
    });
    prisma.apiKey.update.mockRejectedValue(new Error("write failed"));
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { requireAuth } = createAuthMiddleware({ prisma, authModeService });
    const req = createRequest({
      method: "GET",
      originalUrl: "/drawings",
      headers: {
        authorization: `Bearer ${generated.token}`,
      },
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects API keys for routes outside drawings and collections", async () => {
    const { prisma, authModeService } = createDeps();
    authModeService.getAuthEnabled.mockResolvedValue(true);
    const generated = generateApiKey();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "api-key-1",
      tokenHash: generated.tokenHash,
      scopes: serializeApiKeyScopes(),
      revokedAt: null,
      user: {
        id: "admin-1",
        username: "admin",
        email: "admin@test.local",
        name: "Admin",
        role: "ADMIN",
        mustResetPassword: false,
        isActive: true,
      },
    });
    prisma.apiKey.update.mockResolvedValue({});
    const { requireAuth } = createAuthMiddleware({ prisma, authModeService });
    const req = createRequest({
      method: "GET",
      originalUrl: "/auth/api-keys",
      headers: {
        authorization: `Bearer ${generated.token}`,
      },
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects API keys for drawing permission subroutes", async () => {
    const { prisma, authModeService } = createDeps();
    authModeService.getAuthEnabled.mockResolvedValue(true);
    const generated = generateApiKey();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "api-key-1",
      tokenHash: generated.tokenHash,
      scopes: serializeApiKeyScopes(),
      revokedAt: null,
      user: {
        id: "user-1",
        username: "user1",
        email: "user-1@test.local",
        name: "User One",
        role: "USER",
        mustResetPassword: false,
        isActive: true,
      },
    });
    prisma.apiKey.update.mockResolvedValue({});
    const { requireAuth } = createAuthMiddleware({ prisma, authModeService });
    const req = createRequest({
      method: "POST",
      originalUrl: "/drawings/drawing-1/permissions",
      headers: {
        authorization: `Bearer ${generated.token}`,
      },
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not send 403 from optionalAuth when API key is not route-authorized", async () => {
    const { prisma, authModeService } = createDeps();
    authModeService.getAuthEnabled.mockResolvedValue(true);
    const generated = generateApiKey();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "api-key-1",
      tokenHash: generated.tokenHash,
      scopes: serializeApiKeyScopes(),
      revokedAt: null,
      user: {
        id: "user-1",
        username: "user1",
        email: "user-1@test.local",
        name: "User One",
        role: "USER",
        mustResetPassword: false,
        isActive: true,
      },
    });
    prisma.apiKey.update.mockResolvedValue({});
    const { optionalAuth } = createAuthMiddleware({ prisma, authModeService });
    const req = createRequest({
      method: "GET",
      originalUrl: "/drawings/drawing-1/history",
      headers: {
        authorization: `Bearer ${generated.token}`,
      },
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;
    await optionalAuth(req, res, next);
    expect(req.user).toBeUndefined();
    expect(req.authError).toEqual({ code: "INVALID_ACCESS_TOKEN" });
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects API keys missing the required resource scope", async () => {
    const { prisma, authModeService } = createDeps();
    authModeService.getAuthEnabled.mockResolvedValue(true);
    const generated = generateApiKey();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "api-key-1",
      tokenHash: generated.tokenHash,
      scopes: serializeApiKeyScopes(["drawings:read"]),
      revokedAt: null,
      user: {
        id: "user-1",
        username: "user1",
        email: "user-1@test.local",
        name: "User One",
        role: "USER",
        mustResetPassword: false,
        isActive: true,
      },
    });
    prisma.apiKey.update.mockResolvedValue({});
    const { requireAuth } = createAuthMiddleware({ prisma, authModeService });
    const req = createRequest({
      method: "POST",
      originalUrl: "/drawings",
      headers: {
        authorization: `Bearer ${generated.token}`,
      },
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a history-only API key on the restore write endpoint", async () => {
    const { req, res, next } = await authenticateApiKeyRequest([DRAWINGS_HISTORY_SCOPE]);

    expect(req.user).toBeUndefined();
    expect(req.authError).toEqual({ code: "INVALID_ACCESS_TOKEN" });
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects a write-only API key on the restore endpoint", async () => {
    // Restore is a way of reading a snapshot: it makes one the current drawing.
    // History is deliberately not in DEFAULT_API_KEY_SCOPES -- the scope design
    // says it is riskier than editing and must not arrive by accident -- so a
    // key that may write must not reach history through the back door.
    const { req, res, next } = await authenticateApiKeyRequest([DRAWINGS_WRITE_SCOPE]);

    expect(req.user).toBeUndefined();
    expect(req.authError).toEqual({ code: "INVALID_ACCESS_TOKEN" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects a standard read-and-write API key on the restore endpoint", async () => {
    const { req, res, next } = await authenticateApiKeyRequest();

    expect(req.user).toBeUndefined();
    expect(req.authError).toEqual({ code: "INVALID_ACCESS_TOKEN" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("accepts a key holding both write and history on the restore endpoint", async () => {
    const { req, res, next } = await authenticateApiKeyRequest([
      DRAWINGS_WRITE_SCOPE,
      DRAWINGS_HISTORY_SCOPE,
    ]);

    expect(req.user).toMatchObject({ id: "user-1", authCredentialType: "apiKey" });
    expect(req.authError).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("accepts a history-scoped API key on a history read endpoint", async () => {
    const { req, res, next } = await authenticateApiKeyRequest([DRAWINGS_HISTORY_SCOPE], {
      method: "GET",
      originalUrl: "/drawings/drawing-1/history/snapshot-1",
    });

    expect(req.user).toMatchObject({ id: "user-1", authCredentialType: "apiKey" });
    expect(req.authError).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects revoked API keys", async () => {
    const { prisma, authModeService } = createDeps();
    authModeService.getAuthEnabled.mockResolvedValue(true);
    const generated = generateApiKey();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "api-key-1",
      tokenHash: generated.tokenHash,
      revokedAt: new Date(),
      user: { isActive: true },
    });
    const { requireAuth } = createAuthMiddleware({ prisma, authModeService });
    const req = createRequest({
      headers: {
        authorization: `Bearer ${generated.token}`,
      },
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid or revoked API key" }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
