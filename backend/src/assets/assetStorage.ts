/**
 * Where uploaded documents live on disk.
 *
 * Until now this instance had no file storage at all: without S3 the
 * `/api/files` route answers 501 and images are kept as data URLs inside the
 * drawing JSON. That is workable for a screenshot and unworkable for a PDF,
 * whose rendered pages would otherwise be copied into every save and every
 * snapshot.
 *
 * Documents therefore go to disk, and only an id for them goes into the board.
 */
import {
  createBrotliCompress,
  createBrotliDecompress,
  constants as zlibConstants,
} from "node:zlib";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export type StoredFile = {
  storageKey: string;
  /** Size of the original content, which is what a reader receives. */
  sizeBytes: number;
  /** Size on disk. Smaller than sizeBytes when the content was compressed. */
  storedBytes: number;
  /** Set when the file is stored compressed and must be served as such. */
  contentEncoding: "br" | null;
  sha256: string;
};

/**
 * Whether it is worth storing this kind of content compressed.
 *
 * Measured on real files rather than assumed: PDFs compress their own contents
 * already and gain 0-9%, which is not worth the CPU on a small machine. Text
 * and the SVG page previews gain 87-95%.
 *
 * When a file is stored compressed it is also served compressed, with
 * `Content-Encoding`, so the server never spends anything decompressing it —
 * the browser does that. That is the difference from the snapshot codec, where
 * the application itself needs the decompressed bytes.
 */
export function shouldCompress(mimeType: string): boolean {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  return ["image/svg+xml", "application/json", "application/xml", "application/x-ndjson"].includes(
    type,
  );
}

export class AssetTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`File exceeds the ${Math.round(limitBytes / 1024 / 1024)} MB upload limit.`);
    this.name = "AssetTooLargeError";
  }
}

/**
 * Turn a storage key into an absolute path, refusing anything that would leave
 * the storage directory.
 *
 * Keys are generated here and never come from a request, but this is the last
 * gate before a filesystem call — a bug upstream should surface as an error
 * rather than as a read of somewhere else on the disk.
 */
export function resolveStoragePath(root: string, storageKey: string): string {
  const base = resolve(root);
  const full = resolve(base, storageKey);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Storage key "${storageKey}" resolves outside the asset directory.`);
  }
  return full;
}

/**
 * Two levels of hex directories keep any single directory from collecting
 * hundreds of thousands of entries, which some filesystems handle badly.
 *
 * Keyed by blob rather than by asset: the same document uploaded to three
 * boards is one file here and three assets in the database.
 */
export function originalKey(blobId: string): string {
  const safe = blobId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safe.length < 4) throw new Error("Blob id is too short to derive a storage key.");
  return join("originals", safe.slice(0, 2), safe.slice(2, 4), safe);
}

/** Cache keys carry the renderer version so an upgrade cannot serve stale output. */
export function pageCacheKey(
  assetId: string,
  rendererVersion: string,
  page: number,
  extension: string,
): string {
  const safeAsset = assetId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeVersion = rendererVersion.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safeAsset) throw new Error("Asset id must not be empty.");
  if (!safeVersion) throw new Error("Renderer version must not be empty.");
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`Page must be a positive integer, got ${page}.`);
  }
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/g, "");
  return join("cache", safeAsset, safeVersion, `${String(page).padStart(6, "0")}${safeExt}`);
}

/**
 * Stream an upload to disk, hashing as it goes, and refuse it the moment it
 * grows past the limit.
 *
 * Checking Content-Length would be checking a claim; this counts the bytes that
 * actually arrive. The partial file is removed on every failure path, so a
 * refused or interrupted upload leaves nothing behind.
 */
export async function storeStream(
  root: string,
  storageKey: string,
  source: Readable,
  limitBytes: number,
  options: { compress?: boolean } = {},
): Promise<StoredFile> {
  const target = resolveStoragePath(root, storageKey);
  const stagingDir = resolveStoragePath(root, "staging");
  const staging = join(stagingDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.part`);

  await mkdir(stagingDir, { recursive: true });
  await mkdir(dirname(target), { recursive: true });

  const hash = createHash("sha256");
  let sizeBytes = 0;
  let tooLarge = false;

  // The hash is always of the original bytes, never of the compressed form, so
  // the same file uploaded under different compression settings still
  // deduplicates against what is already stored.
  const measure = async function* (chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      sizeBytes += chunk.length;
      if (sizeBytes > limitBytes) {
        tooLarge = true;
        throw new AssetTooLargeError(limitBytes);
      }
      hash.update(chunk);
      yield chunk;
    }
  };

  const stages: any[] = [source, measure];
  if (options.compress) {
    stages.push(
      createBrotliCompress({
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      }),
    );
  }
  const destination = createWriteStream(staging);
  stages.push(destination);

  try {
    // createWriteStream opens its path asynchronously. If an immediately
    // failing source is consumed before that open finishes, pipeline can
    // reject and the cleanup can observe no file yet; the delayed open then
    // creates the .part file after cleanup has already returned. Do not let a
    // fallible source produce anything until the staging path exists.
    await once(destination, "open");
    await pipeline(stages as [Readable, ...any[]]);
  } catch (err) {
    await rm(staging, { force: true });
    if (tooLarge) throw new AssetTooLargeError(limitBytes);
    throw err;
  }

  // Staging and target share a filesystem, so the rename is atomic: a reader
  // sees either no file or the whole file, never a half-written one.
  try {
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { force: true });
    throw err;
  }

  const storedBytes = (await storedSize(root, storageKey)) ?? sizeBytes;
  return {
    storageKey,
    sizeBytes,
    storedBytes,
    contentEncoding: options.compress ? "br" : null,
    sha256: hash.digest("hex"),
  };
}

/** Size of a stored file, or null when it is not there. */
export async function storedSize(root: string, storageKey: string): Promise<number | null> {
  try {
    const info = await stat(resolveStoragePath(root, storageKey));
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Re-read bytes after an in-place preparation step and derive all metadata
 * that identifies the blob. The hash is over the bytes a client receives,
 * matching `storeStream` even when storage compression is in use.
 */
export async function inspectStoredFile(root: string, stored: StoredFile): Promise<StoredFile> {
  const path = resolveStoragePath(root, stored.storageKey);
  const diskBytes = await stat(path);
  if (!diskBytes.isFile()) throw new Error(`Stored asset is not a file: ${stored.storageKey}`);

  const hash = createHash("sha256");
  let sizeBytes = 0;
  const source = createReadStream(path);
  const contents = stored.contentEncoding === "br" ? source.pipe(createBrotliDecompress()) : source;
  for await (const chunk of contents) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.length;
    hash.update(bytes);
  }

  return {
    ...stored,
    sizeBytes,
    storedBytes: diskBytes.size,
    sha256: hash.digest("hex"),
  };
}

/** Read the original bytes represented by a stored blob. */
export async function readStoredBytes(
  root: string,
  stored: Pick<StoredFile, "storageKey" | "contentEncoding">,
): Promise<Buffer> {
  const source = createReadStream(resolveStoragePath(root, stored.storageKey));
  const contents = stored.contentEncoding === "br" ? source.pipe(createBrotliDecompress()) : source;
  const chunks: Buffer[] = [];
  for await (const chunk of contents) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Remove a stored file. Missing counts as success — the goal is that it is gone. */
export async function removeStored(root: string, storageKey: string): Promise<void> {
  await rm(resolveStoragePath(root, storageKey), { force: true });
}

/** Whether the bytes a stored-blob row points at are actually on disk. */
export async function storedFileExists(root: string, storageKey: string): Promise<boolean> {
  try {
    await stat(resolveStoragePath(root, storageKey));
    return true;
  } catch {
    return false;
  }
}
