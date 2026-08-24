import fs from "node:fs";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { API_URL, getCsrfHeaders } from "./api";

/**
 * Everything a spec needs to run its own real-account scenario against a
 * backend that otherwise stays in the no-auth "bootstrap identity" mode the
 * whole rest of this suite (and global-setup.ts) depends on.
 *
 * This is deliberately NOT the general-purpose pattern for this suite --
 * every other spec runs anonymously. Only comments-two-account.spec.ts (the
 * NIL-356 comments/mentions/notifications scenario, which requires real,
 * distinct authenticated accounts by product design -- see
 * docs/product/COMMENTS_GUEST_POLICY.md) needs it, and that spec is
 * responsible for reverting `authEnabled` back to `false` in its own
 * `afterAll`, the same way global-setup.ts left it.
 */

// -- Bootstrap setup code -----------------------------------------------
//
// `POST /auth/auth-enabled {enabled:true}` on a backend with zero active
// users issues a one-time "bootstrap setup code" that the FIRST real
// registration must present. The code is intentionally never returned over
// HTTP: only a SHA-256 hash is stored (backend/src/auth/bootstrapSetupCode.ts)
// and the plaintext is written once to the backend's own log, the same
// "BOOTSTRAP SETUP" line AGENTS.md tells an operator to grep from
// `docker compose logs backend`. This spec is the operator: it reads the
// code the same way, from the backend process's own stdout, captured to a
// file the caller points at via E2E_BACKEND_LOG_FILE. See the spec file's
// header comment for the exact command that sets this up.
//
// The backend logs one structured JSON object per line (backend/src/logger.ts,
// NIL-411/NIL-502) rather than a hand-formatted string -- parse each line as
// JSON and read its fields, instead of a regex over a specific text shape
// that only the log producer controls.
const BOOTSTRAP_CODE_MESSAGE = "BOOTSTRAP SETUP: one-time admin setup code issued";

const readBootstrapCodeLines = (
  content: string,
): { reason: unknown; code: unknown }[] =>
  content
    .split("\n")
    .filter((line) => line.includes(BOOTSTRAP_CODE_MESSAGE))
    .map((line) => {
      try {
        return JSON.parse(line) as { message?: unknown; reason?: unknown; code?: unknown };
      } catch {
        return null;
      }
    })
    .filter(
      (parsed): parsed is { message: unknown; reason: unknown; code: unknown } =>
        parsed !== null && parsed.message === BOOTSTRAP_CODE_MESSAGE,
    );

export const readLatestBootstrapSetupCode = async (params: {
  reason: string;
  timeoutMs?: number;
}): Promise<string> => {
  const logFile = process.env.E2E_BACKEND_LOG_FILE;
  if (!logFile) {
    throw new Error(
      "E2E_BACKEND_LOG_FILE is not set. comments-two-account.spec.ts needs the backend's own " +
        "stdout: the bootstrap setup code is only ever printed there (see " +
        "backend/src/auth/bootstrapSetupCode.ts), never returned over HTTP. Start the backend " +
        "with stdout redirected to a file and export E2E_BACKEND_LOG_FILE=<that file> before " +
        "running this spec (see the spec file header for the exact command).",
    );
  }
  const deadline = Date.now() + (params.timeoutMs ?? 5000);
  for (;;) {
    const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    let latest: string | null = null;
    for (const line of readBootstrapCodeLines(content)) {
      if (line.reason === params.reason && typeof line.code === "string") {
        latest = line.code;
      }
    }
    if (latest) return latest;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for a "${BOOTSTRAP_CODE_MESSAGE}" line with reason "${params.reason}" ` +
          `in ${logFile}. Is the backend actually writing to that file?`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

// -- Small CSRF-aware POST helper, mirroring helpers/api.ts's retry-on-403 --

const postJson = async (
  request: APIRequestContext,
  path: string,
  data: unknown,
): Promise<APIResponse> => {
  const headers = await getCsrfHeaders(request);
  let response = await request.post(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...headers },
    data,
  });
  if (!response.ok() && response.status() === 403) {
    // The cached CSRF token in helpers/api.ts predates whatever just changed
    // this context's session (e.g. the very first call in this file, made
    // before anyone is logged in). Refetch once, directly, and retry.
    const csrfRes = await request.get(`${API_URL}/csrf-token`);
    const csrf = (await csrfRes.json()) as { token: string; header?: string };
    response = await request.post(`${API_URL}${path}`, {
      headers: {
        "Content-Type": "application/json",
        [csrf.header || "x-csrf-token"]: csrf.token,
      },
      data,
    });
  }
  return response;
};

const okOrThrow = async (response: APIResponse, action: string): Promise<any> => {
  if (!response.ok()) {
    const text = await response.text().catch(() => "");
    throw new Error(`${action} failed: HTTP ${response.status()} ${text}`);
  }
  return response.json();
};

// -- Auth mode toggle -----------------------------------------------------
//
// The exact mechanism global-setup.ts and every other spec's no-auth mode
// depend on. Turning it on works from the SAME unauthenticated request
// context global-setup used: while authEnabled=false, requireAuth silently
// authenticates every request as the bootstrap-acting identity (ADMIN role;
// see backend/src/middleware/auth.ts), so this POST needs no login of its
// own. Turning it back off requires a real ADMIN session, because once
// authEnabled=true that free pass disappears -- see
// backend/src/__tests__/auth-enabled.integration.ts for the same contract
// proven at the integration level.
export const toggleAuthEnabled = async (
  request: APIRequestContext,
  enabled: boolean,
): Promise<{ authEnabled: boolean; bootstrapRequired: boolean }> =>
  okOrThrow(
    await postJson(request, "/auth/auth-enabled", { enabled }),
    `Set authEnabled=${enabled}`,
  );

// -- Bootstrap admin registration ------------------------------------------
//
// The first real account after enabling auth is forced through this path
// (backend/src/auth/coreRoutes.ts's `isBootstrapFlow` branch): it reuses the
// existing `bootstrap-admin` row rather than creating a new one. Reusing the
// SAME email/name the placeholder already has ("bootstrap@excalidash.local"
// / "Bootstrap Admin") keeps that row's only externally-visible fields
// unchanged, so if this spec's afterAll ever fails to run, the row stays
// indistinguishable from the untouched placeholder to every other spec (none
// of which reads its isActive/mustResetPassword/passwordHash). Only
// `authEnabled` itself needs a clean revert, and that is a separate,
// verified step (toggleAuthEnabled(request, false) in the spec's afterAll).
export const registerBootstrapAdmin = async (
  request: APIRequestContext,
  params: { email: string; name: string; password: string; setupCode: string },
): Promise<{ id: string; email: string; name: string; role: string }> => {
  const body = await okOrThrow(
    await postJson(request, "/auth/register", params),
    "Bootstrap admin registration",
  );
  return body.user;
};

// -- Ordinary user creation/removal, as the admin ---------------------------
//
// `request` here must already be authenticated as an ADMIN (the same
// context registerBootstrapAdmin just logged in, cookies and all).
export const createAdminUser = async (
  request: APIRequestContext,
  params: { email: string; name: string; password: string; role?: "ADMIN" | "USER" },
): Promise<{ id: string; email: string; name: string }> => {
  const body = await okOrThrow(
    await postJson(request, "/auth/users", {
      ...params,
      isActive: true,
      mustResetPassword: false,
    }),
    `Create user ${params.email}`,
  );
  return body.user;
};

/**
 * Permanently removes a non-admin, non-self account this spec created.
 * `transferTo: "company-archive"` is required by the route even when the
 * user never owned anything (users B and C only ever hold a comment-level
 * grant, never a board of their own) -- there is no "nothing to transfer"
 * option, only a choice of destination.
 */
export const offboardUser = async (request: APIRequestContext, userId: string): Promise<void> => {
  const response = await postJson(request, `/auth/users/${userId}/offboard`, {
    transferTo: "company-archive",
  });
  if (!response.ok() && response.status() !== 404) {
    const text = await response.text().catch(() => "");
    throw new Error(`Offboard ${userId} failed: HTTP ${response.status()} ${text}`);
  }
};

export const grantDrawingPermission = async (
  request: APIRequestContext,
  drawingId: string,
  granteeUserId: string,
  permission: "view" | "comment" | "edit",
): Promise<void> => {
  await okOrThrow(
    await postJson(request, `/drawings/${drawingId}/permissions`, { granteeUserId, permission }),
    `Grant ${permission} on ${drawingId} to ${granteeUserId}`,
  );
};

// -- Real UI login, for the actual scenario (not the setup plumbing above) -
export const loginViaUi = async (
  page: Page,
  params: { email: string; password: string },
): Promise<void> => {
  await page.goto("/login");
  await page.locator("#email").fill(params.email);
  await page.locator("#password").fill(params.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15000 });
};
