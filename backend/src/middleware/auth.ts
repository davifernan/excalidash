import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { logger } from "../logger";
import { PrismaClient } from "../generated/client";
import { prisma as defaultPrisma } from "../db/prisma";
import { createAuthModeService, type AuthModeService } from "../auth/authMode";
import { ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, readCookie } from "../auth/cookies";
import {
  isApiKeyToken,
  resolveApiKeyUser,
  DRAWINGS_HISTORY_SCOPE,
  DRAWINGS_READ_SCOPE,
  DRAWINGS_SHARE_SCOPE,
  DRAWINGS_WRITE_SCOPE,
  DRAWING_READ_SCOPE,
  DRAWING_OPS_SCOPE,
  AGENT_READ_SCOPE,
  AGENT_RUN_SCOPE,
  AGENT_PROMPT_SCOPE,
} from "../auth/apiKeys";
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username?: string | null;
        email: string;
        name: string;
        role: string;
        mustResetPassword?: boolean;
        impersonatorId?: string;
        authCredentialType?: "jwt" | "apiKey" | "bootstrap";
      };
      principal?: {
        kind: "user";
        userId: string;
        allowInactive?: boolean;
        apiKey?: { id: string; scopes: readonly string[] };
      };
      authError?: { code: "INVALID_ACCESS_TOKEN" | "ACCESS_TOKEN_MISSING" };
      /**
       * Set only when the authenticated API key is a drawing-bound agent
       * token (NIL-382). `authorizeApiKeyRequest` has already refused the
       * request unless `req.params.id` equals this value, so a route handler
       * does not need to re-check it to stay safe -- it is exposed for
       * defense in depth and for anything a handler wants to log or assert.
       */
      apiKeyDrawingId?: string | null;
    }
  }
}
interface JwtPayload {
  userId: string;
  email: string;
  type: "access" | "refresh";
  remember?: boolean;
  impersonatorId?: string;
  authProvider?: "local" | "oidc";
  oidcGroups?: string[];
}
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isJwtPayload = (decoded: unknown): decoded is JwtPayload => {
  if (typeof decoded !== "object" || decoded === null) {
    return false;
  }
  const payload = decoded as Record<string, unknown>;
  const impersonatorOk =
    typeof payload.impersonatorId === "undefined" || typeof payload.impersonatorId === "string";
  const authProviderOk =
    typeof payload.authProvider === "undefined" ||
    payload.authProvider === "local" ||
    payload.authProvider === "oidc";
  const oidcGroupsOk =
    typeof payload.oidcGroups === "undefined" || isStringArray(payload.oidcGroups);
  return (
    typeof payload.userId === "string" &&
    typeof payload.email === "string" &&
    (payload.type === "access" || payload.type === "refresh") &&
    impersonatorOk &&
    authProviderOk &&
    oidcGroupsOk
  );
};
const extractToken = (req: Request): { token: string; source: "bearer" | "cookie" } | null => {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === "string") {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") {
      return parts[1] ? { token: parts[1], source: "bearer" } : null;
    }
  }
  const cookieToken = readCookie(req, ACCESS_TOKEN_COOKIE_NAME);
  return cookieToken ? { token: cookieToken, source: "cookie" } : null;
};
const hasRefreshTokenCookie = (req: Request): boolean =>
  readCookie(req, REFRESH_TOKEN_COOKIE_NAME) !== null;
const verifyToken = (token: string): JwtPayload | null => {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (!isJwtPayload(decoded)) {
      return null;
    }
    if (decoded.type !== "access") {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
};
const normalizeRequestPath = (req: Request): string => {
  const raw = (req.originalUrl || req.url || "").split("?")[0] || "";
  return raw.replace(/^\/api(?=\/)/, "");
};
const isAllowedWhileMustResetPassword = (req: Request): boolean => {
  const path = normalizeRequestPath(req);
  if (req.method === "GET" && path === "/auth/me") return true;
  if (req.method === "POST" && path === "/auth/change-password") return true;
  if (req.method === "POST" && path === "/auth/must-reset-password") return true;
  return false;
};
/** Readable with any key: who the key belongs to, and the shared shape library. */
const SCOPE_FREE_API_KEY_PATHS = new Set(["/auth/me", "/library"]);
const getApiKeyRouteResource = (req: Request): "drawings" | "collections" | null => {
  const path = normalizeRequestPath(req);
  const segments = path.split("/").filter(Boolean);
  const method = req.method;
  if (segments[0] === "drawings") {
    if (segments.length === 1 && ["GET", "HEAD", "POST"].includes(method)) {
      return "drawings";
    }
    if (
      segments.length === 2 &&
      segments[1] !== "shared" &&
      ["GET", "HEAD", "PUT", "DELETE"].includes(method)
    ) {
      return "drawings";
    }
    // Drawing sub-resources have their own exact route mapping below. Falling
    // through here must not turn an unknown group into a generic drawing scope.
    return null;
  }
  if (segments[0] === "collections") {
    if (segments.length === 1 && ["GET", "HEAD", "POST"].includes(method)) {
      return "collections";
    }
    if (segments.length === 2 && ["PUT", "DELETE"].includes(method)) {
      return "collections";
    }
    return null;
  }
  return null;
};
const isReadMethod = (method: string): boolean => method === "GET" || method === "HEAD";
const getDrawingSubResourceScopes = (segments: string[], method: string): string[] => {
  const subResource = segments[2];
  if (subResource === "assets") {
    if (segments.length === 3 && method === "POST") return [DRAWINGS_WRITE_SCOPE];
    if (!isReadMethod(method)) return [];
    if (segments.length === 4) return [DRAWINGS_READ_SCOPE];
    if (segments.length === 5 && ["content", "original"].includes(segments[4] ?? "")) {
      return [DRAWINGS_READ_SCOPE];
    }
    if (segments.length === 6 && segments[4] === "pages") return [DRAWINGS_READ_SCOPE];
    return [];
  }
  if (subResource === "history") {
    if (isReadMethod(method) && [3, 4].includes(segments.length)) {
      return [DRAWINGS_HISTORY_SCOPE];
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "restore") {
      // Restoring reads a snapshot and writes the current drawing, so neither
      // permission alone is enough.
      return [DRAWINGS_WRITE_SCOPE, DRAWINGS_HISTORY_SCOPE];
    }
    return [];
  }
  if (subResource === "duplicate" && segments.length === 3 && method === "POST") {
    return [DRAWINGS_WRITE_SCOPE];
  }
  if (subResource === "trim" && segments.length === 3 && method === "POST") {
    return [DRAWINGS_WRITE_SCOPE];
  }
  if (subResource === "files" && segments.length === 4) {
    if (segments[3] === "diff" && isReadMethod(method)) return [DRAWINGS_READ_SCOPE];
    if (segments[3] === "orphans" && method === "DELETE") return [DRAWINGS_WRITE_SCOPE];
    return [];
  }
  if (
    segments.length === 3 &&
    isReadMethod(method) &&
    ["share-resolve", "sharing"].includes(subResource ?? "")
  ) {
    return [DRAWINGS_SHARE_SCOPE];
  }
  if (subResource === "permissions") {
    if (segments.length === 3 && method === "POST") return [DRAWINGS_SHARE_SCOPE];
    if (segments.length === 4 && method === "DELETE") return [DRAWINGS_SHARE_SCOPE];
    return [];
  }
  if (subResource === "link-shares") {
    if (segments.length === 3 && method === "POST") return [DRAWINGS_SHARE_SCOPE];
    if (segments.length === 4 && method === "DELETE") return [DRAWINGS_SHARE_SCOPE];
  }
  return [];
};
export const getRequiredApiKeyScopes = (req: Request): string[] => {
  const segments = normalizeRequestPath(req).split("/").filter(Boolean);
  if (segments[0] === "drawings" && segments.length >= 3) {
    return getDrawingSubResourceScopes(segments, req.method);
  }
  if (segments.length === 2 && segments[0] === "assets" && segments[1] === "usage") {
    return isReadMethod(req.method) ? [DRAWINGS_READ_SCOPE] : [];
  }
  const resource = getApiKeyRouteResource(req);
  if (!resource) return [];
  const access = isReadMethod(req.method) ? "read" : "write";
  return [`${resource}:${access}`];
};

/**
 * The exclusive, exhaustive route surface a drawing-bound agent token
 * (NIL-382) may ever reach: the explicitly listed read/ops/runtime actions
 * below, on its own board only. Returns null for every other
 * request -- including `/drawings/:id` itself, the full scene PUT, history,
 * sharing, and every other drawing sub-resource -- so that surface cannot
 * grow by a route elsewhere in this file happening to match a loose pattern.
 *
 * This function's return value decides everything for an agent token; there
 * is no second, broader path a request can take to reach one (see
 * `authorizeApiKeyRequest` below, which refuses unconditionally when this
 * returns null instead of falling back to the account-wide scope check).
 */
const getAgentRouteDrawingId = (req: Request): { drawingId: string; scope: string } | null => {
  const segments = normalizeRequestPath(req).split("/").filter(Boolean);
  if (segments[0] !== "drawings" || segments.length !== 4 || segments[2] !== "agent") return null;
  const drawingId = segments[1];
  const action = segments[3];
  const method = req.method;
  if (action === "summary" && isReadMethod(method)) return { drawingId, scope: DRAWING_READ_SCOPE };
  if (action === "elements" && isReadMethod(method))
    return { drawingId, scope: DRAWING_READ_SCOPE };
  if (action === "ops" && method === "POST") return { drawingId, scope: DRAWING_OPS_SCOPE };
  if (action === "runtime" && isReadMethod(method)) return { drawingId, scope: AGENT_READ_SCOPE };
  if (action === "run" && isReadMethod(method)) return { drawingId, scope: AGENT_READ_SCOPE };
  if (action === "run" && method === "POST") return { drawingId, scope: AGENT_RUN_SCOPE };
  if (action === "prompt" && method === "POST") return { drawingId, scope: AGENT_PROMPT_SCOPE };
  if (action === "events" && method === "POST") return { drawingId, scope: AGENT_READ_SCOPE };
  return null;
};

/**
 * Pure predicate, no response side effects, so both `requireAuth` (hard
 * 401/403) and `optionalAuth` (soft `req.authError` + fall through to
 * anonymous/share-link handling) decide every API-key request through this
 * exact same rule -- not two independently maintained copies of it. Two
 * copies is exactly how the drawing-bound branch below could stay correct in
 * one auth entry point and rot in the other (NIL-382); see
 * `resolveApiKeyUser`'s comment for the same argument one layer down, at the
 * database lookup itself.
 *
 * A drawing-bound agent token never falls through to the account-wide scope
 * check below, on any code path -- that fallthrough is exactly the "not an
 * agent token after all, so full account rights" shape this repo has been
 * bitten by repeatedly. Every one of its requests is decided right here,
 * unconditionally, against its exact route allowlist and nothing else.
 */
const isApiKeyRequestAuthorized = (
  req: Request,
  scopes: string[],
  apiKeyDrawingId: string | null,
): boolean => {
  if (apiKeyDrawingId) {
    const agentRoute = getAgentRouteDrawingId(req);
    return Boolean(
      agentRoute && agentRoute.drawingId === apiKeyDrawingId && scopes.includes(agentRoute.scope),
    );
  }
  if (req.method === "GET" && SCOPE_FREE_API_KEY_PATHS.has(normalizeRequestPath(req))) {
    return true;
  }
  const requiredScopes = getRequiredApiKeyScopes(req);
  return requiredScopes.length > 0 && requiredScopes.every((scope) => scopes.includes(scope));
};

const authorizeApiKeyRequest = (
  req: Request,
  res: Response,
  scopes: string[],
  apiKeyDrawingId: string | null,
): boolean => {
  if (isApiKeyRequestAuthorized(req, scopes, apiKeyDrawingId)) return true;
  const message = apiKeyDrawingId
    ? "Agent token is not authorized for this route"
    : "API key is not authorized for this route";
  res.status(403).json({ error: "Forbidden", message });
  return false;
};
export type AuthMiddlewareDeps = { prisma: PrismaClient; authModeService: AuthModeService };
export const createAuthMiddleware = ({ prisma, authModeService }: AuthMiddlewareDeps) => {
  const configuredOidcAdminGroups = new Set(config.oidc.adminGroups);
  const normalizeGroups = (groups: string[] | undefined): string[] =>
    Array.from(
      new Set((groups ?? []).map((group) => group.trim()).filter((group) => group.length > 0)),
    );
  const findActiveUser = (userId: string) =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        isActive: true,
      },
    });
  // Delegates to the one shared lookup (auth/apiKeys.ts#resolveApiKeyUser) that
  // also backs the socket handshake, rather than keeping a second copy of the
  // key/expiry/revocation checks here -- see that function's own comment for
  // why a second copy is exactly how a board-bound agent token would end up
  // treated as an account-wide key on whichever entry point drifted (NIL-382).
  const authenticateApiKey = (token: string) => resolveApiKeyUser(prisma, token);
  const shouldReconcileOidcRole = async (payload: JwtPayload, userId: string): Promise<boolean> => {
    if (configuredOidcAdminGroups.size === 0) return false;
    if (payload.impersonatorId) return false;
    if (payload.authProvider === "oidc") return true;
    if (payload.authProvider === "local") return false;
    const linkedOidcIdentity = await prisma.authIdentity.findUnique({
      where: { provider_userId: { provider: "oidc", userId } },
      select: { id: true },
    });
    return Boolean(linkedOidcIdentity);
  };
  const reconcileRoleFromOidcGroups = async (
    payload: JwtPayload,
    user: {
      id: string;
      username: string | null;
      email: string;
      name: string;
      role: string;
      mustResetPassword: boolean;
      isActive: boolean;
    },
  ) => {
    if (!(await shouldReconcileOidcRole(payload, user.id))) {
      return user;
    }
    const oidcGroups = normalizeGroups(payload.oidcGroups);
    const shouldBeAdmin = oidcGroups.some((group) => configuredOidcAdminGroups.has(group));
    const expectedRole = shouldBeAdmin ? "ADMIN" : "USER";
    if (user.role === expectedRole) {
      return user;
    }
    return prisma.user.update({
      where: { id: user.id },
      data: { role: expectedRole },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        mustResetPassword: true,
        isActive: true,
      },
    });
  };
  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authEnabled = await authModeService.getAuthEnabled();
      if (!authEnabled) {
        const user = await authModeService.getBootstrapActingUser();
        req.user = {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role,
          mustResetPassword: user.mustResetPassword,
          authCredentialType: "bootstrap",
        };
        req.principal = { kind: "user", userId: user.id };
        return next();
      }
    } catch (error) {
      logger.error("error reading auth mode", { error });
      res
        .status(500)
        .json({ error: "Internal server error", message: "Failed to read authentication mode" });
      return;
    }
    const extracted = extractToken(req);
    if (!extracted) {
      res.status(401).json({ error: "Unauthorized", message: "Authentication token required" });
      return;
    }
    if (extracted.source === "bearer" && isApiKeyToken(extracted.token)) {
      try {
        const result = await authenticateApiKey(extracted.token);
        if (!result) {
          res.status(401).json({ error: "Unauthorized", message: "Invalid or revoked API key" });
          return;
        }
        const { user, apiKeyId, scopes, drawingId } = result;
        if (!authorizeApiKeyRequest(req, res, scopes, drawingId)) {
          return;
        }
        req.apiKeyDrawingId = drawingId;
        if (user.mustResetPassword && !isAllowedWhileMustResetPassword(req)) {
          res.status(403).json({
            error: "Forbidden",
            code: "MUST_RESET_PASSWORD",
            message: "You must reset your password before using the app",
          });
          return;
        }
        req.user = {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role,
          mustResetPassword: user.mustResetPassword,
          authCredentialType: "apiKey",
        };
        req.principal = { kind: "user", userId: user.id, apiKey: { id: apiKeyId, scopes } };
        next();
      } catch (error) {
        logger.error("error verifying API key", { error });
        res
          .status(500)
          .json({ error: "Internal server error", message: "Failed to verify API key" });
      }
      return;
    }
    const payload = verifyToken(extracted.token);
    if (!payload) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
      return;
    }
    try {
      const user = await findActiveUser(payload.userId);
      if (!user || !user.isActive) {
        res
          .status(401)
          .json({ error: "Unauthorized", message: "User account not found or inactive" });
        return;
      }
      const resolvedUser = await reconcileRoleFromOidcGroups(payload, user);
      if (resolvedUser.mustResetPassword && !isAllowedWhileMustResetPassword(req)) {
        res.status(403).json({
          error: "Forbidden",
          code: "MUST_RESET_PASSWORD",
          message: "You must reset your password before using the app",
        });
        return;
      }
      req.user = {
        id: resolvedUser.id,
        username: resolvedUser.username,
        email: resolvedUser.email,
        name: resolvedUser.name,
        role: resolvedUser.role,
        mustResetPassword: resolvedUser.mustResetPassword,
        impersonatorId: payload.impersonatorId,
        authCredentialType: "jwt",
      };
      req.principal = { kind: "user", userId: resolvedUser.id };
      next();
    } catch (error) {
      logger.error("error verifying user", { error });
      res.status(500).json({ error: "Internal server error", message: "Failed to verify user" });
    }
  };
  const optionalAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authEnabled = await authModeService.getAuthEnabled();
      if (!authEnabled) {
        const user = await authModeService.getBootstrapActingUser();
        req.user = {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role,
          mustResetPassword: user.mustResetPassword,
          authCredentialType: "bootstrap",
        };
        req.principal = { kind: "user", userId: user.id };
        return next();
      }
    } catch (error) {
      logger.error("error reading auth mode", { error });
      return next();
    }
    const extracted = extractToken(req);
    if (!extracted) {
      if (hasRefreshTokenCookie(req)) {
        req.authError = { code: "ACCESS_TOKEN_MISSING" };
        return next();
      }
      return next();
    }
    if (extracted.source === "bearer" && isApiKeyToken(extracted.token)) {
      try {
        const result = await authenticateApiKey(extracted.token);
        if (result && isApiKeyRequestAuthorized(req, result.scopes, result.drawingId)) {
          const { user, apiKeyId, drawingId, scopes } = result;
          req.apiKeyDrawingId = drawingId;
          req.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            name: user.name,
            role: user.role,
            mustResetPassword: user.mustResetPassword,
            authCredentialType: "apiKey",
          };
          req.principal = { kind: "user", userId: user.id, apiKey: { id: apiKeyId, scopes } };
        } else {
          req.authError = { code: "INVALID_ACCESS_TOKEN" };
        }
      } catch (error) {
        logger.error("error in optional API key auth", { error });
        req.authError = { code: "INVALID_ACCESS_TOKEN" };
      }
      return next();
    }
    const payload = verifyToken(extracted.token);
    if (!payload) {
      req.authError = { code: "INVALID_ACCESS_TOKEN" };
      return next();
    }
    try {
      const user = await findActiveUser(payload.userId);
      if (user && user.isActive) {
        req.user = {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role,
          mustResetPassword: user.mustResetPassword,
          impersonatorId: payload.impersonatorId,
          authCredentialType: "jwt",
        };
        req.principal = { kind: "user", userId: user.id };
      }
    } catch (error) {
      logger.error("error in optional auth", { error });
    }
    next();
  };
  return { requireAuth, optionalAuth };
};
const defaultAuthModeService = createAuthModeService(defaultPrisma);
const defaultAuthMiddleware = createAuthMiddleware({
  prisma: defaultPrisma,
  authModeService: defaultAuthModeService,
});
export const authModeService = defaultAuthModeService;
export const requireAuth = defaultAuthMiddleware.requireAuth;
export const optionalAuth = defaultAuthMiddleware.optionalAuth;
