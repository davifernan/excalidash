import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { createServer } from "http";
import { Server } from "socket.io";
import { Worker } from "worker_threads";
import multer from "multer";
import { z } from "zod";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { PrismaClient, Prisma } from "./generated/client";
import {
  sanitizeDrawingData,
  validateImportedDrawing,
  sanitizeText,
  sanitizeSvg,
  elementSchema,
  appStateSchema,
  DrawingDataValidationError,
} from "./security";
import { config } from "./config";
import { authModeService, requireAuth, optionalAuth } from "./middleware/auth";
import { errorHandler, asyncHandler } from "./middleware/errorHandler";
import authRouter from "./auth";
import { logAuditEvent } from "./utils/audit";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerImportExportRoutes } from "./routes/importExport";
import { registerSystemRoutes } from "./routes/system";
import { registerFileRoutes } from "./routes/files";
import { registerStorageRoutes } from "./routes/storage";
import { registerAssetRoutes } from "./assets/assetRoutes";
import { getPage as getAssetPage } from "./assets/pageCache";
import { inspectPdf } from "./assets/pdfRenderer";
import { resolveStoragePath } from "./assets/assetStorage";
import { sweepUnclaimed, collectExpired } from "./assets/assetService";
import { describeShrink, shrinkPdf } from "./assets/pdfShrink";
import { prisma, configureSqlite, reclaimSqliteFreeSpace } from "./db/prisma";
import { createDrawingsCacheStore } from "./server/drawingsCache";
import { registerCsrfProtection } from "./server/csrf";
import { registerSocketHandlers } from "./server/socket";
import { PresenceRegistry } from "./server/presenceRegistry";
import { createHttpsRedirectPolicy, getHttpsRedirectUrl } from "./server/httpsRedirectPolicy";
import { issueBootstrapSetupCodeIfRequired } from "./auth/bootstrapSetupCode";
import { processFilesForS3 as processFilesForS3WithPrisma } from "./fileProcessing";
import { initS3 } from "./s3";
import { startScheduledMaintenance } from "./backups/scheduler";
import { registerLinkPreviewRoutes } from "./linkPreviews/routes";
import { collectExpiredLinkPreviews } from "./linkPreviews/cache";
import { createLinkPreviewService } from "./linkPreviews/service";
const backendRoot = path.resolve(__dirname, "../");
const redactDatabaseUrl = (value: string | undefined): string => {
  if (!value) return "<unset>";
  if (value.startsWith("file:")) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<redacted>";
  }
};
console.log("Resolved DATABASE_URL:", redactDatabaseUrl(process.env.DATABASE_URL));
if (config.s3.bucket) {
  initS3({
    bucket: config.s3.bucket,
    region: config.s3.region,
    endpoint: config.s3.endpoint ?? undefined,
    publicUrl: config.s3.publicUrl ?? undefined,
    forcePathStyle: config.s3.forcePathStyle,
    accessKeyId: config.s3.accessKeyId ?? undefined,
    secretAccessKey: config.s3.secretAccessKey ?? undefined,
  });
  console.log("S3 image storage enabled", { bucket: config.s3.bucket, region: config.s3.region });
}
const normalizeOrigins = (rawOrigins?: string | null): string[] => {
  const fallback = "http://localhost:6767";
  if (!rawOrigins || rawOrigins.trim().length === 0) {
    return [fallback];
  }
  const ensureProtocol = (origin: string) =>
    /^https?:\/\//i.test(origin) ? origin : `http://${origin}`;
  const removeTrailingSlash = (origin: string) =>
    origin.endsWith("/") ? origin.slice(0, -1) : origin;
  const parsed = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(ensureProtocol)
    .map(removeTrailingSlash);
  return parsed.length > 0 ? parsed : [fallback];
};
const allowedOrigins = normalizeOrigins(config.frontendUrl);
console.log("Allowed origins:", allowedOrigins);
const isDev = (process.env.NODE_ENV || "development") !== "production";
const isLocalDevOrigin = (origin: string): boolean => {
  return /^http:\/\/localhost:\d+$/i.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/i.test(origin);
};
const isAllowedOrigin = (origin?: string): boolean => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (isDev && isLocalDevOrigin(origin)) return true;
  return false;
};
const uploadDir = path.resolve(__dirname, "../uploads");
const MAX_UPLOAD_SIZE_BYTES = config.imports.maxArchiveBytes;
const MAX_PAGE_SIZE = 200;
const MAX_IMPORT_ARCHIVE_ENTRIES = 6000;
const MAX_IMPORT_COLLECTIONS = 1000;
const MAX_IMPORT_DRAWINGS = 5000;
const MAX_IMPORT_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_DRAWING_BYTES = 100 * 1024 * 1024;
let cachedBackendVersion: string | null = null;
const getBackendVersion = (): string => {
  if (cachedBackendVersion) return cachedBackendVersion;
  try {
    const raw = fs.readFileSync(path.resolve(backendRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    cachedBackendVersion = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cachedBackendVersion = "unknown";
  }
  return cachedBackendVersion;
};
const initializeUploadDir = async () => {
  try {
    await fsPromises.mkdir(uploadDir, { recursive: true });
  } catch (error) {
    console.error("Failed to create upload directory:", error);
  }
};
const app = express();
const trustProxyConfig = (process.env.TRUST_PROXY ?? "false").trim();
const parsedProxyHops = Number.parseInt(trustProxyConfig, 10);
const trustProxyValue =
  trustProxyConfig === "true"
    ? true
    : trustProxyConfig === "false"
      ? false
      : Number.isFinite(parsedProxyHops) && parsedProxyHops > 0
        ? parsedProxyHops
        : false;
app.set("trust proxy", trustProxyValue);
if (trustProxyValue === true) {
  console.log("[config] trust proxy: enabled (handles multiple proxy layers)");
} else {
  console.log(`[config] trust proxy: ${trustProxyValue}`);
}
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
    credentials: true,
  },
  // Measured: a full 10k-element update is 4.70 MB and the existing maximum
  // embedded-image event is 10.49 MB. 16 MiB admits both together plus margin,
  // while rejecting the former unauthenticated 50 MiB packet before decoding.
  maxHttpBufferSize: config.socketMaxHttpBufferBytes,
});
const parseJsonField = <T>(rawValue: string | null | undefined, fallback: T): T => {
  if (!rawValue) return fallback;
  try {
    return JSON.parse(rawValue) as T;
  } catch (error) {
    console.warn("Failed to parse JSON field", { error, valuePreview: rawValue.slice(0, 50) });
    return fallback;
  }
};
const DRAWINGS_CACHE_TTL_MS = (() => {
  const parsed = Number(process.env.DRAWINGS_CACHE_TTL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5_000;
  }
  return parsed;
})();
const {
  buildDrawingsCacheKey,
  getCachedDrawingsBody,
  cacheDrawingsResponse,
  invalidateDrawingsCache,
} = createDrawingsCacheStore(DRAWINGS_CACHE_TTL_MS);
const getUserTrashCollectionId = (userId: string): string => `trash:${userId}`;
const ensureTrashCollection = async (
  db: Prisma.TransactionClient | PrismaClient,
  userId: string,
): Promise<void> => {
  const trashCollectionId = getUserTrashCollectionId(userId);
  const trashCollection = await db.collection.findFirst({
    where: { id: trashCollectionId, userId },
  });
  if (!trashCollection) {
    await db.collection.create({ data: { id: trashCollectionId, name: "Trash", userId } });
  }
  await db.drawing.updateMany({
    where: { userId, collectionId: "trash" },
    data: { collectionId: trashCollectionId },
  });
};
const PORT = config.port;
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "db") {
      const isSqliteDb = file.originalname.endsWith(".db") || file.originalname.endsWith(".sqlite");
      if (!isSqliteDb) {
        return cb(new Error("Only .db or .sqlite files are allowed"));
      }
    }
    cb(null, true);
  },
});
app.use((req, res, next) => {
  const requestId = uuidv4();
  req.headers["x-request-id"] = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
});
const shouldEnforceHttps =
  config.nodeEnv === "production" &&
  config.enforceHttpsRedirect &&
  allowedOrigins.some((origin) => origin.toLowerCase().startsWith("https://"));
if (shouldEnforceHttps) {
  const httpsRedirectPolicy = createHttpsRedirectPolicy(allowedOrigins);
  app.use((req, res, next) => {
    const redirectUrl = getHttpsRedirectUrl(req, httpsRedirectPolicy);
    if (!redirectUrl) return next();
    return res.redirect(redirectUrl);
  });
}
app.use(
  helmet({
    referrerPolicy: { policy: "no-referrer" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }),
);
app.use(
  cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-csrf-token",
      "x-imported-file",
      "x-share-token",
    ],
    exposedHeaders: ["x-csrf-token", "x-request-id"],
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || "unknown";
  const contentLength = req.headers["content-length"];
  const userEmail = req.user?.email || "anonymous";
  if (contentLength) {
    const sizeInMB = parseInt(contentLength, 10) / 1024 / 1024;
    if (sizeInMB > 10) {
      console.log(
        `[LARGE REQUEST] ${req.method} ${req.path} - ${sizeInMB.toFixed(
          2,
        )}MB - User: ${userEmail} - RequestID: ${requestId}`,
      );
    }
  }
  console.log(
    `[REQUEST] ${req.method} ${req.path} - User: ${userEmail} - IP: ${req.ip} - RequestID: ${requestId}`,
  );
  next();
});
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const generalRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: config.rateLimitMaxRequests,
  message: { error: "Rate limit exceeded", message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
});
app.use(generalRateLimiter);
registerCsrfProtection({
  app,
  isAllowedOrigin,
  maxRequestsPerWindow: config.csrfMaxRequests,
  enableDebugLogging: process.env.DEBUG_CSRF === "true",
});
app.use("/auth", authRouter);
const filesFieldSchema = z
  .union([z.record(z.string(), z.unknown()), z.null()])
  .optional()
  .transform((value) => (value === null ? undefined : value));
const drawingBaseSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  collectionId: z.union([z.string().trim().min(1), z.null()]).optional(),
  preview: z.string().nullable().optional(),
});

const addDrawingSanitizationIssue = (ctx: z.RefinementCtx, error: unknown): void => {
  if (error instanceof DrawingDataValidationError) {
    ctx.addIssue({
      code: "custom",
      message: error.message,
      params: {
        validationCode: error.code,
        maxBytes: error.maxBytes,
      },
    });
    return;
  }

  console.error("Sanitization failed:", error);
  ctx.addIssue({
    code: "custom",
    message: "Invalid or malicious drawing data detected",
  });
};

const drawingCreateSchema = drawingBaseSchema
  .extend({
    elements: elementSchema.array().default([]),
    appState: appStateSchema.default({}),
    files: filesFieldSchema,
  })
  .superRefine((data, ctx) => {
    try {
      const sanitized = sanitizeDrawingData(data);
      Object.assign(data, sanitized);
    } catch (error) {
      addDrawingSanitizationIssue(ctx, error);
    }
  });
const drawingUpdateSchemaBase = drawingBaseSchema.extend({
  elements: elementSchema.array().optional(),
  appState: appStateSchema.optional(),
  files: filesFieldSchema,
  version: z.number().int().positive().optional(),
});
type DrawingUpdateData = {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  preview?: string | null;
  name?: string;
  collectionId?: string | null;
};

const applyDrawingUpdateSanitization = (data: DrawingUpdateData): void => {
  const hasSceneFields =
    data.elements !== undefined || data.appState !== undefined || data.files !== undefined;
  const hasPreviewField = data.preview !== undefined;
  const sanitizedData = { ...data };
  if (hasSceneFields) {
    const fullData = {
      elements: Array.isArray(data.elements) ? data.elements : [],
      appState: typeof data.appState === "object" && data.appState !== null ? data.appState : {},
      files: data.files || {},
      preview: data.preview,
      name: data.name,
      collectionId: data.collectionId,
    };
    const sanitized = sanitizeDrawingData(fullData);
    if (data.elements !== undefined) sanitizedData.elements = sanitized.elements;
    if (data.appState !== undefined) sanitizedData.appState = sanitized.appState;
    if (data.files !== undefined) sanitizedData.files = sanitized.files;
    if (data.preview !== undefined) sanitizedData.preview = sanitized.preview;
    Object.assign(data, sanitizedData);
  } else if (hasPreviewField && typeof data.preview === "string") {
    data.preview = sanitizeSvg(data.preview);
  }
};

export const sanitizeDrawingUpdateData = (data: DrawingUpdateData): boolean => {
  try {
    applyDrawingUpdateSanitization(data);
    return true;
  } catch (error) {
    if (!(error instanceof DrawingDataValidationError)) {
      console.error("Sanitization failed:", error);
    }
    return false;
  }
};
const drawingUpdateSchema = drawingUpdateSchemaBase.superRefine((data, ctx) => {
  try {
    applyDrawingUpdateSanitization(data as DrawingUpdateData);
  } catch (error) {
    addDrawingSanitizationIssue(ctx, error);
  }
});
const respondWithValidationErrors = (res: express.Response, issues: z.ZodIssue[]) => {
  const drawingValidationIssue = issues.find((issue) => {
    const params = (issue as z.ZodIssue & { params?: Record<string, unknown> }).params;
    return issue.code === "custom" && typeof params?.validationCode === "string";
  });
  if (drawingValidationIssue) {
    const params = (drawingValidationIssue as z.ZodIssue & { params: Record<string, unknown> })
      .params;
    const details = typeof params.maxBytes === "number" ? { maxBytes: params.maxBytes } : undefined;
    res.status(400).json({
      error: "Validation error",
      code: params.validationCode,
      message: drawingValidationIssue.message,
      ...(details ? { details } : {}),
    });
    return;
  }

  if (config.nodeEnv === "production") {
    res.status(400).json({ error: "Validation error", message: "Invalid request data" });
  } else {
    res.status(400).json({ error: "Invalid drawing payload", details: issues });
  }
};
const collectionNameSchema = z.string().trim().min(1).max(100);
const validateSqliteHeader = (filePath: string): boolean => {
  try {
    const buffer = Buffer.alloc(16);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);
    if (bytesRead < 16) {
      console.warn("File too small to be a valid SQLite database");
      return false;
    }
    const expectedHeader = Buffer.from([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33,
      0x00,
    ]);
    const isValid = buffer.equals(expectedHeader);
    if (!isValid) {
      console.warn("Invalid SQLite file header detected", {
        filePath,
        header: buffer.toString("hex"),
        expected: expectedHeader.toString("hex"),
      });
    }
    return isValid;
  } catch (error) {
    console.error("Failed to validate SQLite header:", error);
    return false;
  }
};
const verifyDatabaseIntegrityAsync = (filePath: string): Promise<boolean> => {
  if (!validateSqliteHeader(filePath)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const worker = new Worker(path.resolve(__dirname, "./workers/db-verify.js"), {
      workerData: { filePath },
    });
    let timeoutHandle: NodeJS.Timeout;
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };
    worker.on("message", (isValid: boolean) => finish(isValid));
    worker.on("error", (err) => {
      console.error("Worker error:", err);
      finish(false);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(false);
      }
    });
    timeoutHandle = setTimeout(() => {
      console.warn("Integrity check worker timed out", { filePath });
      worker.terminate();
      finish(false);
    }, 10000);
  });
};
const removeFileIfExists = async (filePath?: string) => {
  if (!filePath) return;
  try {
    await fsPromises.access(filePath).catch(() => {
      return;
    });
    await fsPromises.unlink(filePath);
  } catch (error) {
    console.error("Failed to remove file", { filePath, error });
  }
};
// One store, written by the socket server and read by the dashboard routes, so
// neither side has to import the other.
const presences = new PresenceRegistry();
const collaborationAccess = registerSocketHandlers({
  io,
  prisma,
  authModeService,
  jwtSecret: config.jwtSecret,
  presences,
  // The same setting Express uses. Sockets behind a proxy would otherwise all
  // report the proxy's address and share a single anonymous budget.
  trustProxy: trustProxyValue,
  assetStorageDir: config.assets.storageDir,
});
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ok", database: "ok" });
  } catch (error) {
    console.error("Health check failed", error);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});
const enableOnboardingGate =
  config.authMode === "local" &&
  config.nodeEnv === "production" &&
  process.env.DISABLE_ONBOARDING_GATE !== "true";
if (enableOnboardingGate) {
  const ONBOARDING_GATE_TTL_MS = 5_000;
  let onboardingGateCache: { required: boolean; fetchedAt: number } | null = null;
  const isOnboardingGateBypassPath = (reqPath: string): boolean => {
    if (reqPath === "/health") return true;
    if (reqPath === "/csrf-token") return true;
    if (reqPath === "/auth") return true;
    if (reqPath.startsWith("/auth/")) return true;
    return false;
  };
  const isAuthOnboardingRequired = async (): Promise<boolean> => {
    const now = Date.now();
    if (onboardingGateCache && now - onboardingGateCache.fetchedAt < ONBOARDING_GATE_TTL_MS) {
      return onboardingGateCache.required;
    }
    const systemConfig = await authModeService.ensureSystemConfig();
    if (systemConfig.authEnabled || systemConfig.authOnboardingCompleted) {
      onboardingGateCache = { required: false, fetchedAt: now };
      return false;
    }
    const hasActiveUser = await prisma.user.findFirst({
      where: { isActive: true },
      select: { id: true },
    });
    const required = !hasActiveUser;
    onboardingGateCache = { required, fetchedAt: now };
    return required;
  };
  app.use(async (req, res, next) => {
    try {
      if (isOnboardingGateBypassPath(req.path)) return next();
      const required = await isAuthOnboardingRequired();
      if (!required) return next();
      res.setHeader("Clear-Site-Data", '"cache"');
      return res.status(409).json({
        error: "Authentication onboarding required",
        code: "AUTH_ONBOARDING_REQUIRED",
        message:
          "Authentication onboarding is required before using the app. Refresh the page to load the latest UI and complete setup.",
        redirectTo: "/auth-setup",
      });
    } catch (error) {
      console.error("Auth onboarding gate error:", error);
      return next();
    }
  });
}
registerSystemRoutes(app, { asyncHandler, getBackendVersion });
registerDashboardRoutes(app, {
  prisma,
  requireAuth,
  optionalAuth,
  asyncHandler,
  parseJsonField,
  sanitizeText,
  validateImportedDrawing,
  drawingCreateSchema,
  drawingUpdateSchema,
  respondWithValidationErrors,
  collectionNameSchema,
  ensureTrashCollection,
  invalidateDrawingsCache,
  collaborationAccess,
  io,
  buildDrawingsCacheKey,
  getCachedDrawingsBody,
  cacheDrawingsResponse,
  MAX_PAGE_SIZE,
  config,
  logAuditEvent,
  subjectKeySecret: config.jwtSecret,
  presences,
  processFilesForS3: (files, userId, drawingId) =>
    processFilesForS3WithPrisma(files, userId, drawingId, prisma),
});
registerFileRoutes(app, { prisma, requireAuth, optionalAuth, asyncHandler });
registerStorageRoutes(app, {
  prisma,
  requireAuth,
  asyncHandler,
  parseJsonField,
  invalidateDrawingsCache,
  io,
});
registerAssetRoutes({
  app,
  prisma,
  requireAuth,
  optionalAuth,
  asyncHandler,
  storageDir: config.assets.storageDir,
  maxUploadBytes: config.assets.maxUploadBytes,
  maxPerUserBytes: config.assets.maxPerUserBytes,
  getPage: (asset, page, signal) =>
    getAssetPage(
      {
        storageDir: config.assets.storageDir,
        cacheBudgetBytes: config.assets.cacheBudgetBytes,
        minFreeDiskPercent: config.assets.minFreeDiskPercent,
        renderConcurrency: config.assets.renderConcurrency,
        renderQueueLimit: config.assets.renderQueueLimit,
      },
      asset,
      page,
      signal,
    ),
  describeUpload: async (asset) => {
    const info = await inspectPdf(
      resolveStoragePath(config.assets.storageDir, asset.blob.storageKey),
    );
    return { pageCount: info.pageCount };
  },
  optimizeUpload: async (stored) => {
    const result = await shrinkPdf(stored.path, {
      level: config.assets.pdfShrinkLevel,
      minBytes: config.assets.pdfShrinkMinBytes,
      concurrency: config.assets.pdfShrinkConcurrency,
      maxWaiting: config.assets.pdfShrinkQueueLimit,
      onFailure: (error) => {
        console.warn(
          "[assets] PDF rebuild skipped:",
          error instanceof Error ? error.message : error,
        );
      },
    });
    return { note: describeShrink(result) };
  },
});
const linkPreviewDeps = {
  prisma,
  storageDir: config.assets.storageDir,
  config: config.linkPreviews,
};
registerLinkPreviewRoutes({
  app,
  prisma,
  requireAuth,
  asyncHandler,
  storageDir: config.assets.storageDir,
  getPreview: createLinkPreviewService(linkPreviewDeps),
});
registerImportExportRoutes({
  app,
  prisma,
  requireAuth,
  asyncHandler,
  assetStorageDir: config.assets.storageDir,
  upload,
  uploadDir,
  backendRoot,
  getBackendVersion,
  parseJsonField,
  sanitizeText,
  validateImportedDrawing,
  ensureTrashCollection,
  invalidateDrawingsCache,
  removeFileIfExists,
  verifyDatabaseIntegrityAsync,
  MAX_IMPORT_ARCHIVE_ENTRIES,
  MAX_IMPORT_ARCHIVE_BYTES: config.imports.maxArchiveBytes,
  MAX_IMPORT_ENTRY_BYTES: config.imports.maxEntryBytes,
  MAX_IMPORT_COLLECTIONS,
  MAX_IMPORT_DRAWINGS,
  MAX_IMPORT_MANIFEST_BYTES,
  MAX_IMPORT_DRAWING_BYTES,
  MAX_IMPORT_TOTAL_EXTRACTED_BYTES: config.imports.maxExtractedBytes,
  MAX_IMPORT_SCENE_MEMORY_BYTES: config.imports.maxSceneMemoryBytes,
});
app.use(errorHandler);
export { app, httpServer };
const isMain = typeof require !== "undefined" && require.main === module; /**
 * Documents nobody reaches any more.
 *
 * Two stages with a gap between them, on purpose: detaching a widget or
 * deleting a board does not remove anything immediately, so a board deleted by
 * mistake and restored from history still finds its files.
 */
const ASSET_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(async () => {
  const assetDeps = {
    prisma,
    storageDir: config.assets.storageDir,
    maxUploadBytes: config.assets.maxUploadBytes,
    maxPerUserBytes: config.assets.maxPerUserBytes,
  };
  try {
    const swept = await sweepUnclaimed(assetDeps);
    const collected = await collectExpired(assetDeps);
    const expiredPreviews = await collectExpiredLinkPreviews(linkPreviewDeps);
    if (swept.pending || collected.assets || expiredPreviews.previews || expiredPreviews.blobs) {
      console.log(
        `[assets] released ${swept.pending} unclaimed upload(s), ` +
          `removed ${collected.assets} document(s), ${expiredPreviews.previews} link preview(s) ` +
          `and ${collected.blobs + expiredPreviews.blobs} file(s)`,
      );
    }
  } catch (error) {
    console.error("[assets] sweep failed:", error);
  }
}, ASSET_SWEEP_INTERVAL_MS).unref();

const SNAPSHOT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
setInterval(
  async () => {
    try {
      const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_MS);
      const result = await prisma.drawingSnapshot.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        console.log(`[Cleanup] Deleted ${result.count} old drawing snapshots`);
      }
      // Deleting rows only frees SQLite pages; hand the space back too.
      await reclaimSqliteFreeSpace();
    } catch (err) {
      console.error("[Cleanup] Snapshot cleanup failed:", err);
    }
  },
  60 * 60 * 1000,
);
if (isMain) {
  void (async () => {
    await configureSqlite();
    startScheduledMaintenance({
      backups: {
        prisma,
        databaseUrl: config.databaseUrl,
        schedule: config.backups.schedule,
        backupDir: config.backups.dir,
        assetStorageDir: config.assets.storageDir,
        retentionDays: config.backups.retentionDays,
      },
      authCleanup: {
        prisma,
        schedule: config.maintenance.authCleanupSchedule,
        tokenRetentionDays: config.maintenance.authTokenRetentionDays,
        auditRetentionDays: config.maintenance.auditLogRetentionDays,
      },
    });
    httpServer.listen(PORT, async () => {
      await initializeUploadDir();
      try {
        await issueBootstrapSetupCodeIfRequired({
          prisma,
          ttlMs: config.bootstrapSetupCodeTtlMs,
          authMode: config.authMode,
          reason: "startup",
        });
      } catch (error) {
        console.error("Failed to issue bootstrap setup code:", error);
      }
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`Frontend URL: ${config.frontendUrl}`);
    });
  })();
}
