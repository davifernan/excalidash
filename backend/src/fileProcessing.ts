/**
 * Utility for scanning drawing file records and moving embedded base64
 * dataURLs into the shared content-addressed blob store (NIL-381). This is
 * the single interception point for every embedded image on the backend --
 * an explicit PUT /files/:drawingId/:fileId upload (routes/files.ts) is the
 * other, and both end up as the same DrawingFile row through the same
 * assetService.ts#storeDrawingFile, never a second write path.
 */
import { Readable } from "node:stream";
import type { PrismaClient } from "./generated/client";
import { storeDrawingFile, type StoreDrawingFileInput } from "./assets/assetService";
import { logger } from "./logger";

/**
 * Reject anything that could escape the per-drawing storage prefix. Same
 * shape used by `/files/:drawingId/:fileId` route validation.
 */
const VALID_FILE_ID = /^[\w-]{1,200}$/;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/svg+xml",
]);

/**
 * Decode a base64 data URL into a Buffer and its MIME type.
 * Returns null if the string is not a valid data URL.
 */
export const decodeDataURL = (dataURL: string): { buffer: Buffer; mimeType: string } | null => {
  const match = dataURL.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;

  const mimeType = match[1];
  const base64 = match[2];

  try {
    const buffer = Buffer.from(base64, "base64");
    return { buffer, mimeType };
  } catch {
    return null;
  }
};

export type ProcessEmbeddedImagesDeps = {
  prisma: Pick<PrismaClient, "drawingFile" | "asset" | "storedBlob">;
  storageDir: string;
  maxUploadBytes: number;
  maxPerUserBytes: number;
};

/**
 * Scan a drawing's files record for base64 dataURLs, move them into the blob
 * store, and replace the dataURL with the access URL
 * (`/api/files/:drawingId/:fileId`) the frontend already knows how to load
 * from `/files/:drawingId/:fileId` (routes/files.ts).
 *
 * An entry whose bytes are too large, whose declared MIME type is not an
 * accepted image type, or whose owner is over quota is left as a base64
 * dataURL rather than failing the whole save -- the same "skip this one
 * entry" tolerance the old S3 path had for an invalid file id. It is not
 * silently dropped from the scene; the client keeps whatever it already had.
 */
export const processEmbeddedImages = async (
  deps: ProcessEmbeddedImagesDeps,
  files: Record<string, any>,
  ownerUserId: string,
  drawingId: string,
): Promise<Record<string, any>> => {
  const result: Record<string, any> = { ...files };

  // Bound parallel uploads. Without this, a paste of N images fires N
  // parallel blob-store writes, which serializes anyway per owner
  // (withOwnerUploadAdmission) but would otherwise queue unboundedly.
  const UPLOAD_CONCURRENCY = 8;

  const processFile = async ([fileId, file]: [string, any]): Promise<void> => {
    if (!VALID_FILE_ID.test(fileId)) {
      // Reject path-traversal candidates rather than silently storing them
      // under a forged key. Drop from output so the bad entry never reaches
      // the database either.
      logger.warn("skipping file with invalid id", { fileId });
      delete result[fileId];
      return;
    }

    const dataURL: unknown = file?.dataURL;
    if (typeof dataURL !== "string" || !dataURL.startsWith("data:")) {
      // Not a base64 data URL — leave unchanged (https://, /api/files/, etc.)
      return;
    }

    const decoded = decodeDataURL(dataURL);
    if (!decoded) return;
    if (!ALLOWED_IMAGE_MIME_TYPES.has(decoded.mimeType)) {
      logger.warn("skipping unsupported embedded MIME type", { mimeType: decoded.mimeType });
      return;
    }

    const input: StoreDrawingFileInput = {
      drawingId,
      fileId,
      ownerUserId,
      mimeType: decoded.mimeType,
      source: Readable.from(decoded.buffer),
    };

    try {
      await storeDrawingFile(deps, input);
    } catch (error) {
      // Too large or over quota: leave this one entry embedded rather than
      // failing the whole scene save. The client still has a working board;
      // it just did not get the storage benefit for this one image.
      logger.warn("could not move embedded image to storage", { fileId, error });
      return;
    }

    // Drawing-scoped access URL: a file id alone would be ambiguous because
    // the same content hash legitimately repeats across drawings.
    result[fileId] = { ...file, dataURL: `/api/files/${drawingId}/${fileId}` };
  };

  const entries = Object.entries(files);
  for (let i = 0; i < entries.length; i += UPLOAD_CONCURRENCY) {
    await Promise.all(entries.slice(i, i + UPLOAD_CONCURRENCY).map(processFile));
  }

  return result;
};

/**
 * Rewrite an Excalidraw preview SVG so any base64 dataURL that has just been
 * moved to storage is replaced by the resulting access URL.
 *
 * The frontend generates the preview SVG from the canvas state at save time,
 * *before* the round-trip to the backend processes the files; the SVG embeds
 * whatever dataURL the file currently has in `Drawing.files`. Without this
 * rewrite, every save produces a megabyte-scale preview with the full image
 * base64 inlined, even though the image itself is already in storage.
 *
 * Best-effort string substitution: works because the same dataURL string is
 * character-identical in both `files[fileId].dataURL` and the preview SVG's
 * `<image href="...">` attribute. If frontend encoding ever diverges, the
 * worst case is the preview is left as-is.
 */
export const rewritePreviewFileReferences = (
  preview: unknown,
  originalFiles: Record<string, any>,
  processedFiles: Record<string, any>,
): unknown => {
  if (typeof preview !== "string" || preview.length === 0) {
    return preview;
  }
  let rewritten = preview;
  for (const fileId of Object.keys(processedFiles)) {
    const original = originalFiles[fileId];
    const processed = processedFiles[fileId];
    if (
      !original ||
      !processed ||
      typeof original.dataURL !== "string" ||
      typeof processed.dataURL !== "string" ||
      original.dataURL === processed.dataURL ||
      !original.dataURL.startsWith("data:")
    ) {
      continue;
    }
    rewritten = rewritten.split(original.dataURL).join(processed.dataURL);
  }
  return rewritten;
};
