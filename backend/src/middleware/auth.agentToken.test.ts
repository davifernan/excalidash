import type { NextFunction } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_PROMPT_SCOPE,
  AGENT_READ_SCOPE,
  AGENT_RUN_SCOPE,
  generateApiKey,
  serializeApiKeyScopes,
  DRAWING_OPS_SCOPE,
} from "../auth/apiKeys";
import { createAuthMiddleware } from "./auth";
import { createDeps, createRequest, createResponse } from "./authTestHelpers";

/**
 * NIL-382: a drawing-bound agent token (`ApiKey.drawingId` set) must be
 * refused on every route except its own board's three agent routes --
 * unconditionally, never falling through to the account-wide scope check
 * that a null `drawingId` gets. `authorizeApiKeyRequest` in `auth.ts`
 * enforces this by returning inside the `if (apiKeyDrawingId)` branch on
 * every path, so there is no route past this file that can grant a bound
 * token account-wide reach by omission.
 *
 * The scenario worth guarding against is not "an agent token can reach its
 * own board" (that is the feature); it is "an agent token bound to board A
 * reaches board B", or "an agent token reaches some unrelated route", by the
 * fallthrough this file's own history has hit repeatedly elsewhere in this
 * roadmap: a check that only handles the case it was written for and lets
 * everything else default to the wider grant.
 */

const AGENT_TOKEN_ROUTE = {
  method: "POST",
  originalUrl: "/drawings/drawing-A/agent/ops",
};

const runAgentTokenRequest = async (
  request: { method: string; originalUrl: string },
  options: { boundDrawingId?: string; scopes?: readonly string[] } = {},
) => {
  const { prisma, authModeService } = createDeps();
  authModeService.getAuthEnabled.mockResolvedValue(true);
  const generated = generateApiKey();
  prisma.apiKey.findUnique.mockResolvedValue({
    id: "agent-key-1",
    keyId: generated.keyId,
    tokenHash: generated.tokenHash,
    scopes: serializeApiKeyScopes(options.scopes ?? ["drawing:read", "drawing:ops"]),
    drawingId: options.boundDrawingId ?? "drawing-A",
    expiresAt: null,
    revokedAt: null,
    user: {
      id: "owner-1",
      username: "owner",
      email: "owner@test.local",
      name: "Owner",
      role: "USER",
      mustResetPassword: false,
      isActive: true,
    },
  });
  prisma.apiKey.update.mockResolvedValue({});
  const { requireAuth } = createAuthMiddleware({ prisma, authModeService });
  const req = createRequest({
    ...request,
    headers: { authorization: `Bearer ${generated.token}` },
  });
  const res = createResponse();
  const next = vi.fn() as NextFunction;
  await requireAuth(req, res, next);
  return { req, res, next };
};

describe("agent API key authorization (NIL-382)", () => {
  it("reaches its own board's ops route with drawing:ops", async () => {
    const { req, next } = await runAgentTokenRequest(AGENT_TOKEN_ROUTE);
    expect(req.user?.authCredentialType).toBe("apiKey");
    expect(next).toHaveBeenCalledOnce();
  });

  it("lets agent:run start work but does not infer drawing:ops or board write", async () => {
    const allowed = await runAgentTokenRequest(
      { method: "POST", originalUrl: "/drawings/drawing-A/agent/run" },
      { scopes: [AGENT_RUN_SCOPE] },
    );
    expect(allowed.req.principal).toMatchObject({
      apiKey: { id: "agent-key-1", scopes: [AGENT_RUN_SCOPE] },
    });
    expect(allowed.next).toHaveBeenCalledOnce();

    const refused = await runAgentTokenRequest(AGENT_TOKEN_ROUTE, {
      scopes: [AGENT_RUN_SCOPE],
    });
    expect(refused.res.status).toHaveBeenCalledWith(403);
    expect(refused.next).not.toHaveBeenCalled();
  });

  it.each([
    [AGENT_READ_SCOPE, "GET", "/drawings/drawing-A/agent/runtime"],
    [AGENT_READ_SCOPE, "GET", "/drawings/drawing-A/agent/run"],
    [AGENT_READ_SCOPE, "POST", "/drawings/drawing-A/agent/events"],
    [AGENT_PROMPT_SCOPE, "POST", "/drawings/drawing-A/agent/prompt"],
  ])("requires the exact %s scope for %s %s", async (scope, method, originalUrl) => {
    const allowed = await runAgentTokenRequest({ method, originalUrl }, { scopes: [scope] });
    expect(allowed.next).toHaveBeenCalledOnce();

    const refused = await runAgentTokenRequest(
      { method, originalUrl },
      { scopes: [scope === AGENT_READ_SCOPE ? AGENT_PROMPT_SCOPE : AGENT_READ_SCOPE] },
    );
    expect(refused.res.status).toHaveBeenCalledWith(403);
    expect(refused.next).not.toHaveBeenCalled();
  });

  it("reaches its own board's summary and elements routes with drawing:read only", async () => {
    for (const action of ["summary", "elements"]) {
      const { req, next } = await runAgentTokenRequest(
        { method: "GET", originalUrl: `/drawings/drawing-A/agent/${action}` },
        { scopes: ["drawing:read"] },
      );
      expect(req.user?.authCredentialType).toBe("apiKey");
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("is refused on the ops route without drawing:ops (read-only token)", async () => {
    const { req, res, next } = await runAgentTokenRequest(AGENT_TOKEN_ROUTE, {
      scopes: ["drawing:read"],
    });
    expect(req.user).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("REAL ATTACK: is refused on a different board's agent route, even though it is the exact same route shape and scope", async () => {
    const { req, res, next } = await runAgentTokenRequest(
      { method: "POST", originalUrl: "/drawings/drawing-B/agent/ops" },
      { boundDrawingId: "drawing-A" },
    );
    expect(req.user).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("REAL ATTACK: is refused on the scope-free shortcuts (/auth/me, /library) that skip scope checking entirely for any other key", async () => {
    // These two paths are intentionally scope-free for an account-wide key
    // (SCOPE_FREE_API_KEY_PATHS): any key may read who it belongs to and the
    // shared library, without a matching drawings:*/collections:* scope. If
    // a drawing-bound token's unconditional refusal above ever fell through
    // to that check instead of stopping first, THIS is what it would grant --
    // not a route that also happens to be blocked by the disjoint
    // drawing:*/drawings:* scope-string namespace, which every other route in
    // this file coincidentally is. A red-probe that removes the early refusal
    // and only asserts against an "agent" or "drawings" path stays green
    // (getRequiredApiKeyScopes doesn't map "agent" to anything, and no agent
    // scope string ever satisfies a drawings:*/collections:* requirement) --
    // it proves nothing. This one actually depends on the refusal.
    for (const request of [
      { method: "GET", originalUrl: "/auth/me" },
      { method: "GET", originalUrl: "/library" },
    ]) {
      const { req, res, next } = await runAgentTokenRequest(request);
      expect(req.user).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("is refused on its own board's full scene read/write -- the agent surface is the three agent routes only, not the whole board", async () => {
    for (const request of [
      { method: "GET", originalUrl: "/drawings/drawing-A" },
      { method: "PUT", originalUrl: "/drawings/drawing-A" },
    ]) {
      const { req, res, next } = await runAgentTokenRequest(request);
      expect(req.user).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("is refused on unrelated resources entirely (collections, drawing list, history, sharing)", async () => {
    for (const request of [
      { method: "GET", originalUrl: "/collections" },
      { method: "GET", originalUrl: "/drawings" },
      { method: "GET", originalUrl: "/drawings/drawing-A/history" },
      { method: "GET", originalUrl: "/drawings/drawing-A/sharing" },
    ]) {
      const { req, res, next } = await runAgentTokenRequest(request);
      expect(req.user).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("is refused when the route has the wrong segment count or method around /agent/", async () => {
    for (const request of [
      { method: "GET", originalUrl: "/drawings/drawing-A/agent" },
      { method: "GET", originalUrl: "/drawings/drawing-A/agent/ops" }, // ops is POST-only
      { method: "POST", originalUrl: "/drawings/drawing-A/agent/summary" }, // summary is GET-only
      { method: "GET", originalUrl: "/drawings/drawing-A/agent/ops/extra" },
      { method: "GET", originalUrl: "/drawings/drawing-A/agent/unknown-action" },
    ]) {
      const { req, res, next } = await runAgentTokenRequest(request, {
        scopes: ["drawing:read", "drawing:ops"],
      });
      expect(req.user).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
});
