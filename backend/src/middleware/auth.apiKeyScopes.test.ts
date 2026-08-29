import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  DRAWINGS_HISTORY_SCOPE,
  DRAWINGS_READ_SCOPE,
  DRAWINGS_SHARE_SCOPE,
  DRAWINGS_WRITE_SCOPE,
  generateApiKey,
  serializeApiKeyScopes,
} from "../auth/apiKeys";
import { createAuthMiddleware, getRequiredApiKeyScopes } from "./auth";

const request = (method: string, originalUrl: string) => ({ method, originalUrl }) as Request;

const runOptionalApiKeyAuth = async (path: string, scopes: string[]) => {
  const generated = generateApiKey();
  const user = {
    id: "user-1",
    username: "asset-reader",
    email: "reader@example.test",
    name: "Asset Reader",
    role: "USER",
    mustResetPassword: false,
    isActive: true,
  };
  const prisma = {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue({
        id: "key-1",
        keyId: generated.keyId,
        tokenHash: generated.tokenHash,
        scopes: serializeApiKeyScopes(scopes),
        revokedAt: null,
        user,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const { optionalAuth } = createAuthMiddleware({
    prisma: prisma as any,
    authModeService: { getAuthEnabled: vi.fn().mockResolvedValue(true) } as any,
  });
  const req = request("GET", path);
  req.headers = { authorization: `Bearer ${generated.token}` };
  const next = vi.fn() as NextFunction;
  await optionalAuth(req, {} as Response, next);
  return { req, next };
};

describe("API key drawing sub-resource scopes", () => {
  it.each([
    ["POST", "/drawings/board/assets", [DRAWINGS_WRITE_SCOPE]],
    ["GET", "/drawings/board/assets/document", [DRAWINGS_READ_SCOPE]],
    ["GET", "/drawings/board/assets/document/content", [DRAWINGS_READ_SCOPE]],
    ["GET", "/drawings/board/assets/document/original", [DRAWINGS_READ_SCOPE]],
    ["GET", "/drawings/board/assets/document/pages/2", [DRAWINGS_READ_SCOPE]],
    ["GET", "/assets/usage", [DRAWINGS_READ_SCOPE]],
    ["POST", "/drawings/board/duplicate", [DRAWINGS_WRITE_SCOPE]],
    ["POST", "/drawings/board/trim", [DRAWINGS_WRITE_SCOPE]],
    ["GET", "/drawings/board/files/diff", [DRAWINGS_READ_SCOPE]],
    ["DELETE", "/drawings/board/files/orphans", [DRAWINGS_WRITE_SCOPE]],
    ["GET", "/drawings/board/history", [DRAWINGS_HISTORY_SCOPE]],
    ["GET", "/drawings/board/history/snapshot", [DRAWINGS_HISTORY_SCOPE]],
    [
      "POST",
      "/drawings/board/history/snapshot/restore",
      [DRAWINGS_WRITE_SCOPE, DRAWINGS_HISTORY_SCOPE],
    ],
    ["GET", "/drawings/board/share-resolve", [DRAWINGS_SHARE_SCOPE]],
    ["GET", "/drawings/board/sharing", [DRAWINGS_SHARE_SCOPE]],
    ["POST", "/drawings/board/permissions", [DRAWINGS_SHARE_SCOPE]],
    ["DELETE", "/drawings/board/permissions/permission", [DRAWINGS_SHARE_SCOPE]],
    ["POST", "/drawings/board/link-shares", [DRAWINGS_SHARE_SCOPE]],
    ["DELETE", "/drawings/board/link-shares/share", [DRAWINGS_SHARE_SCOPE]],
  ])("maps %s %s to its exact scope", (method, path, scopes) => {
    expect(getRequiredApiKeyScopes(request(method as string, path as string))).toEqual(scopes);
  });

  it("lets a drawings:read key reach a drawing asset", async () => {
    const { req, next } = await runOptionalApiKeyAuth("/drawings/board/assets/document", [
      DRAWINGS_READ_SCOPE,
    ]);
    expect(req.user?.authCredentialType).toBe("apiKey");
    expect(req.principal).toEqual({
      kind: "user",
      userId: "user-1",
      apiKey: { id: "key-1", scopes: [DRAWINGS_READ_SCOPE] },
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects an asset request without the matching scope", async () => {
    const { req, next } = await runOptionalApiKeyAuth("/drawings/board/assets/document", [
      DRAWINGS_WRITE_SCOPE,
    ]);
    expect(req.user).toBeUndefined();
    expect(req.authError).toEqual({ code: "INVALID_ACCESS_TOKEN" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("keeps unknown drawing path groups fail-closed", async () => {
    const path = "/drawings/board/client-invented/nested";
    expect(getRequiredApiKeyScopes(request("GET", path))).toEqual([]);
    const { req, next } = await runOptionalApiKeyAuth(path, [DRAWINGS_READ_SCOPE]);
    expect(req.user).toBeUndefined();
    expect(req.authError).toEqual({ code: "INVALID_ACCESS_TOKEN" });
    expect(next).toHaveBeenCalledOnce();
  });
});
