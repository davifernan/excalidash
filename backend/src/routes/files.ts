/**
 * Board image file routes:
 *   GET  /files/config                  – report whether S3 is configured
 *   PUT  /files/:drawingId/:fileId      – idempotent single-file image upload (NIL-381)
 *   GET  /files/:drawingId/:fileId      – serve an uploaded image, or (legacy)
 *                                          redirect to a presigned S3 GET URL
 *
 * Every route here answers two questions, not one: may this person see (or
 * edit) this board, and does this file actually belong to it. `fileId` alone
 * is not authorization -- a file endpoint gated on fileId instead of board
 * access is exactly the shape NIL-487's authz boundary exists to catch, so
 * every handler below goes through getDrawingAccess like every other
 * board-scoped route, never a bare DrawingFile/S3File lookup.
 */
import express from "express";
import { PrismaClient } from "../generated/client";
import { isS3Enabled, generatePresignedDownloadUrl } from "../s3";
import { canEditDrawing, canViewDrawing, getDrawingAccess, shareLinkTokenFromRequest } from "../authz/sharing";
import { storeDrawingFile, AssetTooLargeError, QuotaExceededError } from "../assets/assetService";
import { streamStoredFile } from "../assets/assetRoutes";
import { resolveStoragePath } from "../assets/assetStorage";

const DOWNLOAD_EXPIRES_IN = 3600; // 1 hour   – cached by browser

/** Loose guard: drawingId / fileId must be safe, path-traversal-free identifiers. */
const isValidIdSegment = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,200}$/.test(value);

/**
 * Images this endpoint accepts, and their canonical MIME strings. Matches
 * fileProcessing.ts's own allowlist -- the two are the same question ("is
 * this bytes-are-an-image claim one we trust to serve back"), asked at two
 * different upload paths (explicit PUT here, embedded data: URL there).
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/svg+xml",
]);

const requestPrincipal = (req: express.Request) =>
  req.user?.authCredentialType === "bootstrap" && req.user.id
    ? { kind: "user" as const, userId: req.user.id, allowInactive: true }
    : (req.principal ?? (req.user?.id ? { kind: "user" as const, userId: req.user.id } : null));

export type FileRouteDeps = {
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  optionalAuth: express.RequestHandler;
  asyncHandler: <T = void>(
    fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<T>,
  ) => express.RequestHandler;
  storageDir: string;
  maxImageUploadBytes: number;
  maxPerUserBytes: number;
};

export const registerFileRoutes = (app: express.Express, deps: FileRouteDeps): void => {
  const { prisma, requireAuth, optionalAuth, asyncHandler, storageDir, maxImageUploadBytes, maxPerUserBytes } =
    deps;

  // ------------------------------------------------------------------
  // GET /files/config
  // ------------------------------------------------------------------
  app.get(
    "/files/config",
    requireAuth,
    asyncHandler(async (_req, res) => {
      return res.json({ s3Enabled: isS3Enabled() });
    }),
  );

  // ------------------------------------------------------------------
  // PUT /files/:drawingId/:fileId
  // Idempotent single-file image upload (NIL-381): the request body is the
  // raw image bytes, Content-Type names the MIME type. Requires edit access
  // to the board -- an uploaded image becomes part of that board's content,
  // the same permission full-scene saves already require.
  // ------------------------------------------------------------------
  app.put(
    "/files/:drawingId/:fileId",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { drawingId, fileId } = req.params;
      if (!isValidIdSegment(drawingId) || !isValidIdSegment(fileId)) {
        return res.status(400).json({ error: "Invalid id segment" });
      }

      const access = await getDrawingAccess({
        prisma,
        principal: requestPrincipal(req),
        drawingId,
        shareToken: shareLinkTokenFromRequest(req),
      });
      if (!canEditDrawing(access)) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const mimeType = String(req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        return res.status(415).json({
          error: "Unsupported file type",
          message: `"${mimeType || "unknown"}" is not an accepted image type.`,
        });
      }

      const drawing = await prisma.drawing.findUnique({ where: { id: drawingId }, select: { userId: true } });
      if (!drawing) return res.status(404).json({ error: "Drawing not found" });

      try {
        const result = await storeDrawingFile(
          { prisma, storageDir, maxUploadBytes: maxImageUploadBytes, maxPerUserBytes },
          {
            drawingId,
            fileId,
            // Quota is charged to the board owner, not whoever dropped the
            // image -- same policy as document uploads (assetRoutes.ts).
            ownerUserId: drawing.userId,
            mimeType,
            source: req,
          },
        );
        return res.json({
          drawingId,
          fileId,
          mimeType: result.drawingFile.mimeType,
          sizeBytes: result.sizeBytes,
        });
      } catch (error) {
        if (error instanceof AssetTooLargeError) {
          return res.status(413).json({
            error: "File too large",
            message: error.message,
          });
        }
        if (error instanceof QuotaExceededError) {
          return res.status(507).json({
            error: "Storage limit reached",
            message: error.message,
          });
        }
        throw error;
      }
    }),
  );

  // ------------------------------------------------------------------
  // GET /files/:drawingId/:fileId
  // Serves an uploaded image from the local blob store (NIL-381). Falls
  // back to the legacy S3-redirect path for a (drawingId, fileId) pair that
  // predates this endpoint and only ever landed in S3File -- read
  // compatibility, not a second write path (nothing writes S3File anymore).
  // ------------------------------------------------------------------
  app.get(
    "/files/:drawingId/:fileId",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const { drawingId, fileId } = req.params;
      if (!isValidIdSegment(drawingId) || !isValidIdSegment(fileId)) {
        return res.status(400).json({ error: "Invalid id segment" });
      }

      // Drawing access decides authorization; fall back to 404 on
      // miss so we don't leak existence of a (drawing, fileId) pair.
      const access = await getDrawingAccess({
        prisma,
        principal: requestPrincipal(req),
        drawingId,
        shareToken: shareLinkTokenFromRequest(req),
      });
      if (!canViewDrawing(access)) {
        return res.status(404).json({ error: "File not found" });
      }

      const drawingFile = await prisma.drawingFile.findUnique({
        where: { drawingId_fileId: { drawingId, fileId } },
        include: { blob: true },
      });
      if (drawingFile) {
        const { blob } = drawingFile;
        res.setHeader("Content-Type", drawingFile.mimeType);
        res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
        res.setHeader("ETag", `"${blob.sha256}"`);
        // Streamed compressed, not decompressed server-side: Content-Encoding
        // tells the browser to do that instead, the same as document downloads.
        if (blob.contentEncoding) res.setHeader("Content-Encoding", blob.contentEncoding);
        streamStoredFile(res, resolveStoragePath(storageDir, blob.storageKey));
        return;
      }

      if (!isS3Enabled()) {
        return res.status(404).json({ error: "File not found" });
      }

      const s3Record = await prisma.s3File.findUnique({
        where: { drawingId_fileId: { drawingId, fileId } },
      });
      if (!s3Record) {
        return res.status(404).json({ error: "File not found" });
      }

      const downloadUrl = await generatePresignedDownloadUrl(s3Record.s3Key, DOWNLOAD_EXPIRES_IN);
      return res.redirect(302, downloadUrl);
    }),
  );
};
