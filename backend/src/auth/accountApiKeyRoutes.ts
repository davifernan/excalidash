import { Request, Response } from "express";
import { logAuditEvent } from "../utils/audit";
import { apiKeyCreateSchema } from "./schemas";
import {
  AGENT_TOKEN_MAX_TTL_MS,
  AGENT_TOKEN_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  DRAWINGS_HISTORY_SCOPE,
  DRAWINGS_SHARE_SCOPE,
  generateApiKey,
  parseApiKeyScopes,
  serializeApiKeyScopes,
} from "./apiKeys";
import type { RegisterAccountRoutesDeps } from "./accountRoutes";
import { disconnectApiKeySockets } from "../server/socketRevocation";
import { canEditDrawing, getDrawingAccess } from "../authz/sharing";

const serializeApiKeyMetadata = (apiKey: {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  drawingId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: apiKey.id,
  name: apiKey.name,
  prefix: apiKey.prefix,
  scopes: parseApiKeyScopes(apiKey.scopes),
  drawingId: apiKey.drawingId,
  expiresAt: apiKey.expiresAt,
  lastUsedAt: apiKey.lastUsedAt,
  revokedAt: apiKey.revokedAt,
  createdAt: apiKey.createdAt,
  updatedAt: apiKey.updatedAt,
});

/** Account-wide key scopes only -- never call this for a drawing-bound agent token. */
const normalizeAccountApiKeyScopes = (scopes: string[] | undefined): string[] | null => {
  if (!scopes) return [...DEFAULT_API_KEY_SCOPES];
  // The opt-in scopes are grantable but not granted by default, so an agent
  // can be given history or sharing access without every key carrying it.
  const allowedScopes = new Set<string>([
    ...DEFAULT_API_KEY_SCOPES,
    DRAWINGS_HISTORY_SCOPE,
    DRAWINGS_SHARE_SCOPE,
  ]);
  const normalized = Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
  if (normalized.length === 0 || normalized.some((scope) => !allowedScopes.has(scope))) {
    return null;
  }
  return normalized;
};

/**
 * Drawing-bound agent token scopes only (NIL-382). A disjoint allow-list from
 * the account-wide one above -- `drawing:read`/`drawing:ops` can never be
 * validated by `normalizeAccountApiKeyScopes`, and `drawings:read`/
 * `drawings:write` can never be validated by this function, so a caller
 * cannot get an account-wide-shaped key past the agent-token creation path
 * or vice versa.
 */
const normalizeAgentApiKeyScopes = (scopes: string[] | undefined): string[] | null => {
  const requested = scopes ?? [...AGENT_TOKEN_SCOPES];
  const allowedScopes = new Set<string>(AGENT_TOKEN_SCOPES);
  const normalized = Array.from(new Set(requested.map((scope) => scope.trim()).filter(Boolean)));
  if (normalized.length === 0 || normalized.some((scope) => !allowedScopes.has(scope))) {
    return null;
  }
  return normalized;
};

export const registerAccountApiKeyRoutes = (deps: RegisterAccountRoutesDeps) => {
  const {
    router,
    prisma,
    requireAuth,
    accountActionRateLimiter,
    ensureAuthEnabled,
    config,
    requireCsrf,
    sanitizeText,
  } = deps;
  router.get("/api-keys", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized", message: "User not authenticated" });
      }

      const apiKeys = await prisma.apiKey.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          drawingId: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.json({ apiKeys: apiKeys.map(serializeApiKeyMetadata) });
    } catch (error) {
      console.error("List API keys error:", error);
      return res.status(500).json({
        error: "Internal server error",
        message: "Failed to list API keys",
      });
    }
  });

  router.post(
    "/api-keys",
    requireAuth,
    accountActionRateLimiter,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireCsrf(req, res)) return;
        if (!req.user) {
          return res.status(401).json({ error: "Unauthorized", message: "User not authenticated" });
        }
        if (req.user.impersonatorId) {
          return res.status(403).json({
            error: "Forbidden",
            message: "API key creation is not allowed while impersonating",
          });
        }

        const parsed = apiKeyCreateSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Validation error",
            message: "API key name must be between 1 and 100 characters",
          });
        }

        const { drawingId } = parsed.data;

        if (drawingId) {
          // A name here is a claim, not a grant: re-check the caller's own
          // edit access to the drawing server-side, the same way every other
          // board-scoped mutation does. Without this, anyone could mint an
          // agent token bound to a board they cannot edit -- the token would
          // then fail downstream authz on every request, but the account
          // that owns the key would have leaked the fact that the drawing
          // id exists and quietly hold a permanently-inert credential for
          // someone else's board.
          const access = await getDrawingAccess({
            prisma,
            principal: { kind: "user", userId: req.user.id },
            drawingId,
          });
          if (!canEditDrawing(access)) {
            return res.status(404).json({
              error: "Drawing not found",
              message: "Drawing does not exist",
            });
          }

          const scopes = normalizeAgentApiKeyScopes(parsed.data.scopes);
          if (!scopes) {
            return res.status(400).json({
              error: "Validation error",
              message: `Agent token scopes must be a non-empty subset of ${AGENT_TOKEN_SCOPES.join(", ")}`,
            });
          }

          const requestedTtlMs = parsed.data.expiresInDays
            ? parsed.data.expiresInDays * 24 * 60 * 60 * 1000
            : AGENT_TOKEN_MAX_TTL_MS;
          const expiresAt = new Date(Date.now() + Math.min(requestedTtlMs, AGENT_TOKEN_MAX_TTL_MS));

          const generated = generateApiKey();
          const apiKey = await prisma.apiKey.create({
            data: {
              userId: req.user.id,
              name: sanitizeText(parsed.data.name, 100),
              keyId: generated.keyId,
              tokenHash: generated.tokenHash,
              prefix: generated.prefix,
              scopes: serializeApiKeyScopes(scopes),
              drawingId,
              expiresAt,
            },
            select: {
              id: true,
              name: true,
              prefix: true,
              scopes: true,
              drawingId: true,
              expiresAt: true,
              lastUsedAt: true,
              revokedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          });

          if (config.enableAuditLogging) {
            await logAuditEvent({
              userId: req.user.id,
              action: "agent_api_key_created",
              resource: `api_key:${apiKey.id}:drawing:${drawingId}`,
              ipAddress: req.ip || req.connection.remoteAddress || undefined,
              userAgent: req.headers["user-agent"] || undefined,
            });
          }

          return res.status(201).json({
            apiKey: serializeApiKeyMetadata(apiKey),
            token: generated.token,
          });
        }

        const scopes = normalizeAccountApiKeyScopes(parsed.data.scopes);
        if (!scopes) {
          return res.status(400).json({
            error: "Validation error",
            message: "Select at least one valid API key scope",
          });
        }

        const generated = generateApiKey();
        const apiKey = await prisma.apiKey.create({
          data: {
            userId: req.user.id,
            name: sanitizeText(parsed.data.name, 100),
            keyId: generated.keyId,
            tokenHash: generated.tokenHash,
            prefix: generated.prefix,
            scopes: serializeApiKeyScopes(scopes),
          },
          select: {
            id: true,
            name: true,
            prefix: true,
            scopes: true,
            drawingId: true,
            expiresAt: true,
            lastUsedAt: true,
            revokedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (config.enableAuditLogging) {
          await logAuditEvent({
            userId: req.user.id,
            action: "api_key_created",
            resource: `api_key:${apiKey.id}`,
            ipAddress: req.ip || req.connection.remoteAddress || undefined,
            userAgent: req.headers["user-agent"] || undefined,
          });
        }

        return res.status(201).json({
          apiKey: serializeApiKeyMetadata(apiKey),
          token: generated.token,
        });
      } catch (error) {
        console.error("Create API key error:", error);
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to create API key",
        });
      }
    },
  );

  router.delete(
    "/api-keys/:id",
    requireAuth,
    accountActionRateLimiter,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireCsrf(req, res)) return;
        if (!req.user) {
          return res.status(401).json({ error: "Unauthorized", message: "User not authenticated" });
        }
        if (req.user.impersonatorId) {
          return res.status(403).json({
            error: "Forbidden",
            message: "API key revocation is not allowed while impersonating",
          });
        }

        const apiKey = await prisma.apiKey.findFirst({
          where: { id: req.params.id, userId: req.user.id },
          select: { id: true, revokedAt: true },
        });
        if (!apiKey) {
          return res.status(404).json({ error: "Not found", message: "API key not found" });
        }
        if (!apiKey.revokedAt) {
          await prisma.apiKey.update({
            where: { id: apiKey.id },
            data: { revokedAt: new Date() },
          });
        }
        await disconnectApiKeySockets(apiKey.id);

        if (config.enableAuditLogging) {
          await logAuditEvent({
            userId: req.user.id,
            action: "api_key_revoked",
            resource: `api_key:${apiKey.id}`,
            ipAddress: req.ip || req.connection.remoteAddress || undefined,
            userAgent: req.headers["user-agent"] || undefined,
          });
        }

        return res.json({ success: true });
      } catch (error) {
        console.error("Revoke API key error:", error);
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to revoke API key",
        });
      }
    },
  );
};
