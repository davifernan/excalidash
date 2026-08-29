/**
 * Configuration validation and environment variable management
 */
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import {
  type PasswordPolicyConfig,
  buildPasswordPolicyMessage,
  resolvePasswordPolicyConfig,
  validatePasswordAgainstPolicy,
} from "./config/passwordPolicy";
import { validateProductionConfig } from "./config/production";
import { DEFAULT_SOCKET_MAX_HTTP_BUFFER_BYTES, assertSocketLimitContract } from "./limits";

export { buildPasswordPolicyMessage, validatePasswordAgainstPolicy };

dotenv.config();

interface S3Config {
  bucket: string | null;
  region: string;
  endpoint: string | null;
  publicUrl: string | null;
  forcePathStyle: boolean;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  keyPrefix: string;
}

type MailTransport = "resend" | "smtp" | "none";

interface MailConfig {
  transport: MailTransport;
  resendApiKey: string | null;
  from: string | null;
  replyTo: string | null;
  smtp: {
    host: string | null;
    port: number;
    secure: boolean;
    user: string | null;
    password: string | null;
  };
}

/**
 * An explicit MAIL_TRANSPORT always wins. Otherwise the transport follows
 * whatever is configured, so adding credentials is enough to enable delivery.
 */
const resolveMailTransport = (
  resendApiKey: string | null,
  smtpHost: string | null,
): MailTransport => {
  const explicit = process.env.MAIL_TRANSPORT?.trim().toLowerCase();
  if (explicit === "resend" || explicit === "smtp" || explicit === "none") {
    return explicit;
  }
  if (explicit) {
    throw new Error("MAIL_TRANSPORT must be one of: resend, smtp, none");
  }
  if (resendApiKey) return "resend";
  if (smtpHost) return "smtp";
  return "none";
};

interface BackupConfig {
  schedule: string | null;
  dir: string;
  retentionDays: number;
  maxAgeMs: number;
  maxCount: number;
  maxTotalBytes: number;
  minFreeDiskPercent: number;
}

interface ShareLinkConfig {
  editDefaultTtlMs: number;
  viewDefaultTtlMs: number;
  maxTtlMs: number;
}

interface UpdateCheckConfig {
  outboundEnabled: boolean;
  githubToken: string | null;
}

export type AgentRuntimeConfig = {
  /** Null means the board remains fully usable with no runtime attached. */
  herdr: {
    socketPath: string;
    workingDirectory: string;
    profiles: Array<{ id: string; label: string; agentKind: string; args: string[] }>;
  } | null;
};

interface ReadinessConfig {
  cacheTtlMs: number;
}

interface ImportConfig {
  maxArchiveBytes: number;
  maxEntryBytes: number;
  maxExtractedBytes: number;
  maxSceneMemoryBytes: number;
}

interface MaintenanceConfig {
  authCleanupSchedule: string;
  authTokenRetentionDays: number;
  auditLogRetentionDays: number;
}

interface Config {
  port: number;
  nodeEnv: string;
  /** Sentry-compatible ingest DSN. Empty keeps error reporting completely disabled. */
  errorTrackerDsn: string | null;
  databaseUrl?: string;
  frontendUrl?: string;
  authMode: AuthMode;
  jwtSecret: string;
  jwtAccessExpiresIn: string;
  jwtRefreshExpiresIn: string;
  /** Longer refresh lifetime for logins that asked to stay signed in. */
  jwtRefreshExpiresInRemembered: string;
  rateLimitMaxRequests: number;
  csrfMaxRequests: number;
  csrfSecret: string | null;
  oidc: OidcConfig;
  enablePasswordReset: boolean;
  enableRefreshTokenRotation: boolean;
  enableAuditLogging: boolean;
  enableSnapshotCompression: boolean;
  snapshotMaxCountPerDrawing: number;
  enforceHttpsRedirect: boolean;
  bootstrapSetupCodeTtlMs: number;
  bootstrapSetupCodeMaxAttempts: number;
  passwordPolicy: PasswordPolicyConfig;
  backups: BackupConfig;
  readiness: ReadinessConfig;
  imports: ImportConfig;
  maintenance: MaintenanceConfig;
  mail: MailConfig;
  s3: S3Config;
  assets: AssetConfig;
  socketMaxHttpBufferBytes: number;
  linkPreviews: LinkPreviewConfig;
  shareLinks: ShareLinkConfig;
  logLevel: LogLevel;
  enableSnapshotVacuum: boolean;
  /** `true`/`false`, or a positive hop count for a chain of trusted proxies. */
  trustProxy: boolean | number;
  debugCsrf: boolean;
  disableOnboardingGate: boolean;
  drawingsCacheTtlMs: number;
  apiKeyHashPepper: string;
  updateCheck: UpdateCheckConfig;
  agentRuntime: AgentRuntimeConfig;
}

export type LogLevel = "silent" | "info" | "debug";

const LOG_LEVELS: readonly LogLevel[] = ["silent", "info", "debug"];

/**
 * Uploaded documents.
 *
 * `storageDir` sits under the existing backend-data volume, so an instance that
 * already backs that volume up keeps working without a new mount.
 *
 * `fileBaseUrl` is empty by default, which serves documents from the app's own
 * origin. Pointing it at a cookie-free host later reduces what a mistake in
 * this area could reach, and needs no code change.
 */
export interface AssetConfig {
  storageDir: string;
  fileBaseUrl: string | null;
  maxUploadBytes: number;
  /// Own limit for a board image (NIL-381), smaller than a document upload's
  /// default -- a canvas image is not expected to approach 30 MB, and a
  /// separate ceiling means a misconfigured client cannot spend a whole
  /// board's images against the document upload budget by accident.
  maxImageUploadBytes: number;
  maxPerUserBytes: number;
  cacheBudgetBytes: number;
  minFreeDiskPercent: number;
  renderConcurrency: number;
  renderQueueLimit: number;
  /**
   * Rebuilding an uploaded PDF re-encodes its images and can make an
   * image-heavy document a fraction of its size. "printer" keeps 300 dpi and
   * is not distinguishable at normal viewing size; "off" leaves every upload
   * byte-for-byte as it arrived.
   */
  pdfShrinkLevel: "printer" | "ebook" | "screen" | "off";
  pdfShrinkMinBytes: number;
  pdfShrinkConcurrency: number;
  pdfShrinkQueueLimit: number;
}

export interface LinkPreviewConfig {
  positiveTtlMs: number;
  negativeTtlMs: number;
  dnsTimeoutMs: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
  allowedPorts: number[];
  dnsConcurrency: number;
  dnsQueueSize: number;
  maxPageWireBytes: number;
  maxPageDecodedBytes: number;
  maxImageWireBytes: number;
  maxImageDecodedBytes: number;
  maxSanitizedImageBytes: number;
  maxImagePixels: number;
  maxImageDimension: number;
  maxFaviconDimension: number;
  imageProcessTimeoutMs: number;
  maxConcurrentPerUser: number;
  maxConcurrentInstance: number;
  maxQueueSize: number;
  cacheBudgetBytes: number;
  maxBytesPerUser: number;
  maxEntriesPerUser: number;
  minFreeDiskPercent: number;
  cleanupBatchSize: number;
}

export type AuthMode = "local" | "hybrid" | "oidc_enforced";

interface OidcConfig {
  enabled: boolean;
  enforced: boolean;
  providerName: string;
  issuerUrl: string | null;
  discoveryUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
  idTokenSignedResponseAlg: string | null;
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post" | null;
  scopes: string;
  emailClaim: string;
  emailVerifiedClaim: string;
  groupsClaim: string;
  adminGroups: string[];
  requireEmailVerified: boolean;
  jitProvisioning: boolean;
  firstUserAdmin: boolean;
}

const ALLOWED_OIDC_ID_TOKEN_ALGS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "HS256",
  "HS384",
  "HS512",
]);

const getOptionalEnv = (key: string, defaultValue: string): string => {
  return process.env[key] || defaultValue;
};

const getOptionalTrimmedEnv = (key: string): string | null => {
  const raw = process.env[key];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getOptionalOidcSigningAlg = (key: string): string | null => {
  const raw = process.env[key];
  if (!raw) return null;
  const normalized = raw.trim();

  if (normalized.length === 0 || normalized.toLowerCase() === "none") {
    throw new Error(`${key} must not be empty or 'none'`);
  }
  if (!ALLOWED_OIDC_ID_TOKEN_ALGS.has(normalized)) {
    throw new Error(`${key} must be one of: ${Array.from(ALLOWED_OIDC_ID_TOKEN_ALGS).join(", ")}`);
  }

  return normalized;
};

const getOptionalOidcTokenEndpointAuthMethod = (
  key: string,
): "none" | "client_secret_basic" | "client_secret_post" | null => {
  const raw = process.env[key];
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (
    normalized === "none" ||
    normalized === "client_secret_basic" ||
    normalized === "client_secret_post"
  ) {
    return normalized;
  }
  throw new Error(`${key} must be one of: none, client_secret_basic, client_secret_post`);
};

const parseCsvEnvList = (key: string): string[] => {
  const raw = process.env[key];
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const parsePortList = (key: string, fallback: number[]): number[] => {
  const entries = parseCsvEnvList(key);
  if (entries.length === 0) return fallback;
  const ports = entries.map(Number);
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error(`${key} must contain comma-separated TCP ports between 1 and 65535`);
  }
  return [...new Set(ports)];
};

const resolveJwtSecret = (nodeEnv: string): string => {
  const provided = process.env.JWT_SECRET;
  if (provided && provided.trim().length > 0) {
    return provided;
  }

  if (nodeEnv === "production") {
    throw new Error("Missing required environment variable: JWT_SECRET");
  }

  const generated = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[security] JWT_SECRET is not set (non-production). Using an ephemeral secret; tokens will be invalidated on restart.",
  );
  return generated;
};

const parseFrontendUrl = (raw: string | undefined): string | undefined => {
  if (!raw || raw.trim().length === 0) return undefined;
  const normalized = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .join(",");
  return normalized.length > 0 ? normalized : undefined;
};

const resolveDatabaseUrl = (rawUrl?: string) => {
  const backendRoot = path.resolve(__dirname, "../");
  const defaultDbPath = path.resolve(backendRoot, "prisma/dev.db");

  if (!rawUrl || rawUrl.trim().length === 0) {
    return `file:${defaultDbPath}`;
  }

  if (!rawUrl.startsWith("file:")) {
    return rawUrl;
  }

  const filePath = rawUrl.replace(/^file:/, "");
  const prismaDir = path.resolve(backendRoot, "prisma");
  const normalizedRelative = filePath.replace(/^\.\/?/, "");
  const hasLeadingPrismaDir =
    normalizedRelative === "prisma" || normalizedRelative.startsWith("prisma/");

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(hasLeadingPrismaDir ? backendRoot : prismaDir, normalizedRelative);

  return `file:${absolutePath}`;
};

process.env.DATABASE_URL = resolveDatabaseUrl(process.env.DATABASE_URL);

const getOptionalBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
};

/**
 * A per-request line for every request is the volume that made the
 * production log unreadable; a level nobody can turn back up loses the
 * ability to trace a specific report. "debug" keeps today's per-request
 * line for local development and an explicit opt-in; "info" (the
 * production default) keeps only the anomalies -- a large upload -- that
 * are worth a line on their own; "silent" drops both for an instance that
 * ships its own request logging elsewhere. Errors are unaffected by this:
 * `errorHandler` always logs, regardless of level.
 */
const resolveLogLevel = (nodeEnv: string): LogLevel => {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw) {
    if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }
  return nodeEnv === "development" ? "debug" : "info";
};

const getRequiredEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for environment variable ${key}: must be a positive number`);
  }
  return parsed;
};

const parseAuthMode = (rawValue: string | undefined): AuthMode => {
  const normalized = (rawValue || "local").trim().toLowerCase();
  if (normalized === "local" || normalized === "hybrid" || normalized === "oidc_enforced") {
    return normalized;
  }
  throw new Error("Invalid AUTH_MODE. Expected one of: local, hybrid, oidc_enforced");
};

const resolveOidcConfig = (authMode: AuthMode): OidcConfig => {
  const issuerUrl = getOptionalTrimmedEnv("OIDC_ISSUER_URL");
  const discoveryUrl = getOptionalTrimmedEnv("OIDC_DISCOVERY_URL");
  const clientId = getOptionalTrimmedEnv("OIDC_CLIENT_ID");
  const clientSecret = getOptionalTrimmedEnv("OIDC_CLIENT_SECRET");
  const redirectUri = getOptionalTrimmedEnv("OIDC_REDIRECT_URI");
  const groupsClaim = getOptionalEnv("OIDC_GROUPS_CLAIM", "groups").trim();
  const adminGroups = parseCsvEnvList("OIDC_ADMIN_GROUPS");
  const requiredWhenEnabled = {
    OIDC_ISSUER_URL: issuerUrl,
    OIDC_CLIENT_ID: clientId,
    OIDC_REDIRECT_URI: redirectUri,
  };

  if (groupsClaim.length === 0) {
    throw new Error("Invalid OIDC_GROUPS_CLAIM: must be a non-empty claim key/path");
  }

  const enabled = authMode !== "local";
  const missingRequired = Object.entries(requiredWhenEnabled)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (enabled && missingRequired.length > 0) {
    throw new Error(
      `AUTH_MODE=${authMode} requires OIDC configuration. Missing: ${missingRequired.join(", ")}`,
    );
  }

  if (!enabled) {
    const hasOidcVars =
      Object.values(requiredWhenEnabled).some((value) => Boolean(value)) || adminGroups.length > 0;
    if (hasOidcVars) {
      console.warn("[config] AUTH_MODE=local; ignoring OIDC_* provider settings.");
    }
  }

  const idTokenSignedResponseAlg = enabled
    ? getOptionalOidcSigningAlg("OIDC_ID_TOKEN_SIGNED_RESPONSE_ALG")
    : null;
  const tokenEndpointAuthMethod = enabled
    ? getOptionalOidcTokenEndpointAuthMethod("OIDC_TOKEN_ENDPOINT_AUTH_METHOD")
    : null;
  if (
    enabled &&
    idTokenSignedResponseAlg &&
    /^HS/i.test(idTokenSignedResponseAlg) &&
    !clientSecret
  ) {
    throw new Error(
      "OIDC_ID_TOKEN_SIGNED_RESPONSE_ALG using HS* requires OIDC_CLIENT_SECRET for a confidential client",
    );
  }

  return {
    enabled,
    enforced: authMode === "oidc_enforced",
    providerName: getOptionalEnv("OIDC_PROVIDER_NAME", "OIDC"),
    issuerUrl,
    discoveryUrl,
    clientId,
    clientSecret,
    redirectUri,
    idTokenSignedResponseAlg,
    tokenEndpointAuthMethod,
    scopes: getOptionalEnv("OIDC_SCOPES", "openid profile email"),
    emailClaim: getOptionalEnv("OIDC_EMAIL_CLAIM", "email"),
    emailVerifiedClaim: getOptionalEnv("OIDC_EMAIL_VERIFIED_CLAIM", "email_verified"),
    groupsClaim,
    adminGroups,
    requireEmailVerified: getOptionalBoolean("OIDC_REQUIRE_EMAIL_VERIFIED", true),
    jitProvisioning: getOptionalBoolean("OIDC_JIT_PROVISIONING", true),
    firstUserAdmin: getOptionalBoolean("OIDC_FIRST_USER_ADMIN", true),
  };
};

const resolveBackupConfig = (): BackupConfig => {
  const backupDir = getOptionalTrimmedEnv("BACKUP_DIR") || path.resolve(__dirname, "../backups");
  return {
    schedule: getOptionalTrimmedEnv("BACKUP_SCHEDULE"),
    dir: backupDir,
    retentionDays: getRequiredEnvNumber("BACKUP_RETENTION_DAYS", 14),
    maxAgeMs: getRequiredEnvNumber("BACKUP_MAX_AGE_HOURS", 48) * 60 * 60 * 1000,
    maxCount: getRequiredEnvNumber("BACKUP_MAX_COUNT", 7),
    maxTotalBytes: getRequiredEnvNumber("BACKUP_MAX_TOTAL_MB", 30 * 1024) * 1024 * 1024,
    minFreeDiskPercent: getRequiredEnvNumber("BACKUP_MIN_FREE_DISK_PERCENT", 20),
  };
};

/**
 * Mirrors the tri-state Express `trust proxy` setting: `true` (always
 * trust), `false` (never), or a positive hop count for a known chain of
 * reverse proxies. An unparseable value falls back to `false` rather than
 * throwing, matching the pre-NIL-505 behavior in index.ts.
 */
const resolveTrustProxy = (): boolean | number => {
  const raw = (process.env.TRUST_PROXY ?? "false").trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  const hops = Number.parseInt(raw, 10);
  return Number.isFinite(hops) && hops > 0 ? hops : false;
};

const resolvedAuthMode = parseAuthMode(process.env.AUTH_MODE);

const resolveSocketMaxHttpBufferBytes = (): number => {
  const configuredMb = getRequiredEnvNumber(
    "SOCKET_MAX_HTTP_BUFFER_MB",
    DEFAULT_SOCKET_MAX_HTTP_BUFFER_BYTES / 1024 / 1024,
  );
  const configuredBytes = configuredMb * 1024 * 1024;
  assertSocketLimitContract(configuredBytes);
  return configuredBytes;
};

const resolveS3Config = (): S3Config => ({
  bucket: getOptionalTrimmedEnv("S3_BUCKET"),
  region: getOptionalEnv("S3_REGION", "us-east-1"),
  endpoint: getOptionalTrimmedEnv("S3_ENDPOINT"),
  publicUrl: getOptionalTrimmedEnv("S3_PUBLIC_URL"),
  forcePathStyle: getOptionalEnv("S3_FORCE_PATH_STYLE", "false").toLowerCase() === "true",
  accessKeyId: getOptionalTrimmedEnv("AWS_ACCESS_KEY_ID"),
  secretAccessKey: getOptionalTrimmedEnv("AWS_SECRET_ACCESS_KEY"),
  keyPrefix: (getOptionalEnv("S3_KEY_PREFIX", "excalidash") || "excalidash").replace(/\/+$/, ""),
});

const resolveAgentRuntimeConfig = (): AgentRuntimeConfig => {
  const socketPath = getOptionalTrimmedEnv("AGENT_RUNTIME_HERDR_SOCKET_PATH");
  const workingDirectory = getOptionalTrimmedEnv("AGENT_RUNTIME_HERDR_WORKING_DIRECTORY");
  const rawProfiles = getOptionalTrimmedEnv("AGENT_RUNTIME_HERDR_PROFILES");
  if (!socketPath && !workingDirectory && !rawProfiles) return { herdr: null };
  if (!socketPath || !workingDirectory || !rawProfiles) {
    throw new Error(
      "AGENT_RUNTIME_HERDR_SOCKET_PATH, AGENT_RUNTIME_HERDR_WORKING_DIRECTORY and AGENT_RUNTIME_HERDR_PROFILES must be configured together",
    );
  }
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(workingDirectory)) {
    throw new Error(
      "AGENT_RUNTIME_HERDR_SOCKET_PATH and AGENT_RUNTIME_HERDR_WORKING_DIRECTORY must be absolute paths",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawProfiles);
  } catch {
    throw new Error("AGENT_RUNTIME_HERDR_PROFILES must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
    throw new Error("AGENT_RUNTIME_HERDR_PROFILES must contain between 1 and 20 profiles");
  }
  const profiles = parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`AGENT_RUNTIME_HERDR_PROFILES[${index}] must be an object`);
    }
    const profile = entry as Record<string, unknown>;
    const args = profile.args ?? [];
    if (
      typeof profile.id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile.id) ||
      typeof profile.label !== "string" ||
      profile.label.trim().length === 0 ||
      profile.label.length > 80 ||
      typeof profile.agentKind !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(profile.agentKind) ||
      !Array.isArray(args) ||
      args.length > 20 ||
      !args.every((arg) => typeof arg === "string" && arg.length <= 500)
    ) {
      throw new Error(`AGENT_RUNTIME_HERDR_PROFILES[${index}] is invalid`);
    }
    return {
      id: profile.id,
      label: profile.label.trim(),
      agentKind: profile.agentKind,
      args: args as string[],
    };
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("AGENT_RUNTIME_HERDR_PROFILES ids must be unique");
  }
  return { herdr: { socketPath, workingDirectory, profiles } };
};

export const config: Config = {
  port: getRequiredEnvNumber("PORT", 8000),
  nodeEnv: getOptionalEnv("NODE_ENV", "development"),
  errorTrackerDsn: getOptionalTrimmedEnv("ERROR_TRACKER_DSN"),
  logLevel: resolveLogLevel(getOptionalEnv("NODE_ENV", "development")),
  databaseUrl: process.env.DATABASE_URL,
  frontendUrl: parseFrontendUrl(process.env.FRONTEND_URL),
  authMode: resolvedAuthMode,
  jwtSecret: resolveJwtSecret(getOptionalEnv("NODE_ENV", "development")),
  jwtAccessExpiresIn: getOptionalEnv("JWT_ACCESS_EXPIRES_IN", "15m"),
  jwtRefreshExpiresIn: getOptionalEnv("JWT_REFRESH_EXPIRES_IN", "7d"),
  jwtRefreshExpiresInRemembered: getOptionalEnv("JWT_REFRESH_EXPIRES_IN_REMEMBERED", "30d"),
  rateLimitMaxRequests: getRequiredEnvNumber("RATE_LIMIT_MAX_REQUESTS", 1000),
  csrfMaxRequests: getRequiredEnvNumber("CSRF_MAX_REQUESTS", 60),
  csrfSecret: process.env.CSRF_SECRET || null,
  socketMaxHttpBufferBytes: resolveSocketMaxHttpBufferBytes(),
  enableSnapshotVacuum: getOptionalEnv("ENABLE_SNAPSHOT_VACUUM", "true").toLowerCase() !== "false",
  trustProxy: resolveTrustProxy(),
  debugCsrf: getOptionalBoolean("DEBUG_CSRF", false),
  disableOnboardingGate: getOptionalBoolean("DISABLE_ONBOARDING_GATE", false),
  drawingsCacheTtlMs: getRequiredEnvNumber("DRAWINGS_CACHE_TTL_MS", 5_000),
  apiKeyHashPepper: getOptionalEnv("API_KEY_HASH_PEPPER", "api-key-hash-pepper"),
  updateCheck: {
    // Kept permissive (true/1/yes) to match the documented UPDATE_CHECK_OUTBOUND
    // contract in AGENTS.md -- getOptionalBoolean only accepts true/1.
    outboundEnabled: ["true", "1", "yes"].includes(
      (getOptionalEnv("UPDATE_CHECK_OUTBOUND", "true") || "true").trim().toLowerCase(),
    ),
    githubToken:
      getOptionalTrimmedEnv("UPDATE_CHECK_GITHUB_TOKEN") ?? getOptionalTrimmedEnv("GITHUB_TOKEN"),
  },
  agentRuntime: resolveAgentRuntimeConfig(),
  oidc: resolveOidcConfig(resolvedAuthMode),
  enablePasswordReset: getOptionalBoolean("ENABLE_PASSWORD_RESET", false),
  enableRefreshTokenRotation: getOptionalBoolean("ENABLE_REFRESH_TOKEN_ROTATION", true),
  enableAuditLogging: getOptionalBoolean("ENABLE_AUDIT_LOGGING", false),
  enableSnapshotCompression: getOptionalBoolean("ENABLE_SNAPSHOT_COMPRESSION", true),
  snapshotMaxCountPerDrawing: getRequiredEnvNumber("SNAPSHOT_MAX_COUNT_PER_DRAWING", 100),
  enforceHttpsRedirect: getOptionalBoolean("ENFORCE_HTTPS_REDIRECT", true),
  bootstrapSetupCodeTtlMs: getRequiredEnvNumber("BOOTSTRAP_SETUP_CODE_TTL_MS", 15 * 60 * 1000),
  bootstrapSetupCodeMaxAttempts: getRequiredEnvNumber("BOOTSTRAP_SETUP_CODE_MAX_ATTEMPTS", 10),
  passwordPolicy: resolvePasswordPolicyConfig(getRequiredEnvNumber, getOptionalBoolean),
  backups: resolveBackupConfig(),
  readiness: {
    cacheTtlMs: getRequiredEnvNumber("READINESS_CACHE_TTL_MS", 30_000),
  },
  imports: {
    // Archives stay on disk. These limits bound disk usage and each inflated
    // stream independently, including highly-compressible ZIP bombs.
    maxArchiveBytes: getRequiredEnvNumber("IMPORT_MAX_ARCHIVE_MB", 2300) * 1024 * 1024,
    maxEntryBytes: getRequiredEnvNumber("IMPORT_MAX_ENTRY_MB", 128) * 1024 * 1024,
    maxExtractedBytes: getRequiredEnvNumber("IMPORT_MAX_EXTRACTED_MB", 2200) * 1024 * 1024,
    // Parsed JSON expands beyond its UTF-8 representation. Keep all drawing
    // and snapshot payloads admitted by the importer well below a small VPS's
    // Node heap even when the archive/disk allowance is much larger.
    maxSceneMemoryBytes: getRequiredEnvNumber("IMPORT_MAX_SCENE_MEMORY_MB", 64) * 1024 * 1024,
  },
  maintenance: {
    authCleanupSchedule: getOptionalEnv("AUTH_CLEANUP_SCHEDULE", "0 0 3 * * *"),
    authTokenRetentionDays: getRequiredEnvNumber("AUTH_TOKEN_RETENTION_DAYS", 30),
    auditLogRetentionDays: getRequiredEnvNumber("AUDIT_LOG_RETENTION_DAYS", 365),
  },
  mail: {
    transport: resolveMailTransport(
      getOptionalTrimmedEnv("RESEND_API_KEY"),
      getOptionalTrimmedEnv("SMTP_HOST"),
    ),
    resendApiKey: getOptionalTrimmedEnv("RESEND_API_KEY"),
    from: getOptionalTrimmedEnv("MAIL_FROM"),
    replyTo: getOptionalTrimmedEnv("MAIL_REPLY_TO"),
    smtp: {
      host: getOptionalTrimmedEnv("SMTP_HOST"),
      port: getRequiredEnvNumber("SMTP_PORT", 587),
      secure: getOptionalBoolean("SMTP_SECURE", false),
      user: getOptionalTrimmedEnv("SMTP_USER"),
      password: getOptionalTrimmedEnv("SMTP_PASSWORD"),
    },
  },
  s3: resolveS3Config(),
  assets: {
    storageDir: getOptionalEnv("ASSET_STORAGE_DIR", "/app/prisma/assets"),
    fileBaseUrl: getOptionalTrimmedEnv("ASSET_FILE_BASE_URL"),
    // Miro refuses uploads past 30 MB; matching that keeps expectations sane
    // and keeps a single document from filling a small VPS.
    maxUploadBytes: getRequiredEnvNumber("ASSET_MAX_UPLOAD_MB", 30) * 1024 * 1024,
    // A canvas image is not a 30 MB document; 15 MB comfortably covers even a
    // large pasted screenshot without lending the whole document budget to it.
    maxImageUploadBytes: getRequiredEnvNumber("ASSET_MAX_IMAGE_UPLOAD_MB", 15) * 1024 * 1024,
    maxPerUserBytes: getRequiredEnvNumber("ASSET_MAX_PER_USER_MB", 2048) * 1024 * 1024,
    // Page previews are recomputable, so this is a ceiling to evict against,
    // not a quota to respect.
    cacheBudgetBytes: getRequiredEnvNumber("ASSET_CACHE_BUDGET_MB", 512) * 1024 * 1024,
    // Stop rendering before the disk is full: a machine that cannot write is
    // worse than a document that is slow to open.
    minFreeDiskPercent: getRequiredEnvNumber("ASSET_MIN_FREE_DISK_PERCENT", 20),
    // One page at a time. Rendering foreign PDFs is the expensive and risky
    // part; doing several at once is how a small machine falls over.
    renderConcurrency: getRequiredEnvNumber("ASSET_RENDER_CONCURRENCY", 1),
    renderQueueLimit: getRequiredEnvNumber("ASSET_RENDER_QUEUE_LIMIT", 32),
    // Only files where the saving is worth it. Below this a rebuild risks
    // changing a document for a gain nobody would notice.
    pdfShrinkLevel: (["printer", "ebook", "screen", "off"] as const).includes(
      getOptionalEnv("ASSET_PDF_SHRINK", "printer") as any,
    )
      ? (getOptionalEnv("ASSET_PDF_SHRINK", "printer") as "printer" | "ebook" | "screen" | "off")
      : "printer",
    pdfShrinkMinBytes: getRequiredEnvNumber("ASSET_PDF_SHRINK_MIN_MB", 4) * 1024 * 1024,
    pdfShrinkConcurrency: getRequiredEnvNumber("ASSET_PDF_SHRINK_CONCURRENCY", 1),
    pdfShrinkQueueLimit: getRequiredEnvNumber("ASSET_PDF_SHRINK_QUEUE_LIMIT", 2),
  },
  shareLinks: {
    editDefaultTtlMs: getRequiredEnvNumber(
      "LINK_SHARE_EDIT_DEFAULT_TTL_MS",
      7 * 24 * 60 * 60 * 1000,
    ),
    viewDefaultTtlMs: getRequiredEnvNumber(
      "LINK_SHARE_VIEW_DEFAULT_TTL_MS",
      30 * 24 * 60 * 60 * 1000,
    ),
    maxTtlMs: getRequiredEnvNumber("LINK_SHARE_MAX_TTL_MS", 90 * 24 * 60 * 60 * 1000),
  },
  linkPreviews: {
    positiveTtlMs: getRequiredEnvNumber("LINK_PREVIEW_POSITIVE_TTL_MS", 24 * 60 * 60 * 1000),
    negativeTtlMs: getRequiredEnvNumber("LINK_PREVIEW_NEGATIVE_TTL_MS", 15 * 60 * 1000),
    dnsTimeoutMs: getRequiredEnvNumber("LINK_PREVIEW_DNS_TIMEOUT_MS", 2_000),
    connectTimeoutMs: getRequiredEnvNumber("LINK_PREVIEW_CONNECT_TIMEOUT_MS", 3_000),
    totalTimeoutMs: getRequiredEnvNumber("LINK_PREVIEW_TOTAL_TIMEOUT_MS", 8_000),
    maxRedirects: getRequiredEnvNumber("LINK_PREVIEW_MAX_REDIRECTS", 3),
    // Link cards are web clients, not general-purpose TCP proxies. Additional
    // web ports must be explicitly opted into by an operator.
    allowedPorts: parsePortList("LINK_PREVIEW_ALLOWED_PORTS", [80, 443]),
    dnsConcurrency: getRequiredEnvNumber("LINK_PREVIEW_DNS_CONCURRENCY", 8),
    dnsQueueSize: getRequiredEnvNumber("LINK_PREVIEW_DNS_QUEUE_SIZE", 64),
    // Both the bytes on the wire and the bytes after Content-Encoding are
    // bounded independently. The latter is what defeats gzip/brotli bombs.
    maxPageWireBytes: getRequiredEnvNumber("LINK_PREVIEW_MAX_PAGE_WIRE_KB", 256) * 1024,
    maxPageDecodedBytes: getRequiredEnvNumber("LINK_PREVIEW_MAX_PAGE_DECODED_KB", 512) * 1024,
    maxImageWireBytes: getRequiredEnvNumber("LINK_PREVIEW_MAX_IMAGE_WIRE_MB", 4) * 1024 * 1024,
    maxImageDecodedBytes:
      getRequiredEnvNumber("LINK_PREVIEW_MAX_IMAGE_DECODED_MB", 8) * 1024 * 1024,
    maxSanitizedImageBytes:
      getRequiredEnvNumber("LINK_PREVIEW_MAX_STORED_IMAGE_MB", 2) * 1024 * 1024,
    maxImagePixels: getRequiredEnvNumber("LINK_PREVIEW_MAX_IMAGE_PIXELS", 16_000_000),
    maxImageDimension: getRequiredEnvNumber("LINK_PREVIEW_MAX_IMAGE_DIMENSION", 2_048),
    maxFaviconDimension: getRequiredEnvNumber("LINK_PREVIEW_MAX_FAVICON_DIMENSION", 256),
    imageProcessTimeoutMs: getRequiredEnvNumber("LINK_PREVIEW_IMAGE_TIMEOUT_MS", 10_000),
    maxConcurrentPerUser: getRequiredEnvNumber("LINK_PREVIEW_CONCURRENCY_PER_USER", 2),
    maxConcurrentInstance: getRequiredEnvNumber("LINK_PREVIEW_CONCURRENCY_INSTANCE", 4),
    maxQueueSize: getRequiredEnvNumber("LINK_PREVIEW_QUEUE_SIZE", 16),
    cacheBudgetBytes: getRequiredEnvNumber("LINK_PREVIEW_CACHE_BUDGET_MB", 256) * 1024 * 1024,
    maxBytesPerUser: getRequiredEnvNumber("LINK_PREVIEW_MAX_PER_USER_MB", 64) * 1024 * 1024,
    maxEntriesPerUser: getRequiredEnvNumber("LINK_PREVIEW_MAX_ENTRIES_PER_USER", 100),
    minFreeDiskPercent: getRequiredEnvNumber("LINK_PREVIEW_MIN_FREE_DISK_PERCENT", 20),
    cleanupBatchSize: getRequiredEnvNumber("LINK_PREVIEW_CLEANUP_BATCH_SIZE", 100),
  },
};

if (config.nodeEnv === "production") {
  validateProductionConfig(config);
}

console.log("Configuration validated successfully");
