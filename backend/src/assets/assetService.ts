/**
 * Uploaded documents: the bookkeeping around the bytes.
 *
 * Two ideas carry this module.
 *
 * Bytes and documents are separate. The same PDF dropped onto three boards by
 * three people is one file on disk and three assets in the database, each with
 * its own name, owner and quota. Sharing one row across owners instead would
 * make one person's delete able to take away someone else's document.
 *
 * A board only ever names an asset by id. Filename, page count, MIME type and
 * permission are read from here on every request, never taken from the element
 * that referred to them — a board's contents are written by clients, and a
 * client is not a source of truth about what it is allowed to see.
 */
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  AssetTooLargeError,
  inspectStoredFile,
  originalKey,
  removeStored,
  resolveStoragePath,
  shouldCompress,
  storedFileExists,
  storeStream,
} from "./assetStorage";
import type { StoredFile } from "./assetStorage";

export type AssetKind = "PDF" | "MARKDOWN" | "TEXT";

/** Grace period for an upload that no save ever referred to. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Grace period before bytes nobody references are removed from disk. */
const BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

export class QuotaExceededError extends Error {
  constructor(usedBytes: number, limitBytes: number) {
    super(
      `Storage limit reached: ${Math.round(usedBytes / 1024 / 1024)} MB of ` +
        `${Math.round(limitBytes / 1024 / 1024)} MB in use. Delete a document to free space.`,
    );
    this.name = "QuotaExceededError";
  }
}

/** A scene was composed against a document reference that this board has since replaced. */
export class StaleDrawingAssetReferenceError extends Error {
  code = "STALE_DOCUMENT_ASSET_REFERENCE" as const;
  assetIds: readonly string[];

  constructor(message: string, assetIds: readonly string[]) {
    super(message);
    this.name = "StaleDrawingAssetReferenceError";
    this.assetIds = assetIds;
  }
}

type Deps = {
  prisma: any;
  storageDir: string;
  maxUploadBytes: number;
  maxPerUserBytes: number;
  now?: () => number;
};

type BlobDeps = Pick<Deps, "prisma" | "storageDir">;

/**
 * Put trusted, already-validated bytes into the shared content-addressed blob
 * store. Document uploads and generated link-preview images both use this so
 * deduplication, atomic publication and cleanup semantics stay identical.
 */
export async function storeBlob(
  deps: BlobDeps,
  input: {
    source: Readable;
    limitBytes: number;
    compress?: boolean;
    purpose?: "ASSET" | "LINK_PREVIEW" | "IMAGE";
    prepareStored?: (
      stored: Readonly<StoredFile & { path: string }>,
    ) => Promise<{ note: string | null }>;
  },
) {
  const provisionalId = randomUUID();
  let stored = await storeStream(
    deps.storageDir,
    originalKey(provisionalId),
    input.source,
    input.limitBytes,
    { compress: input.compress },
  );

  let preparation: { note: string | null } | undefined;
  if (input.prepareStored) {
    try {
      preparation = await input.prepareStored({
        ...stored,
        path: resolveStoragePath(deps.storageDir, stored.storageKey),
      });
      // Preparation is allowed to replace the file. Never trust its reported
      // size or the pre-preparation hash for content-addressed deduplication.
      stored = await inspectStoredFile(deps.storageDir, stored);
    } catch (error) {
      await removeStored(deps.storageDir, stored.storageKey);
      throw error;
    }
  }

  let blob = await deps.prisma.storedBlob.findUnique({ where: { sha256: stored.sha256 } });
  // Matching bytes are only worth reusing if the bytes are still there. A row
  // whose file has gone — a partial restore, a file removed by hand — would
  // otherwise swallow every later upload of the same content: each one appears
  // to succeed and none of them can ever be read. The upload just made is a
  // perfectly good replacement, so adopt it instead of throwing it away.
  // Not READY means somebody has claimed it for deletion and its file is about
  // to go, so it is no more reusable than one that has already gone.
  if (
    blob &&
    (blob.state !== "READY" || !(await storedFileExists(deps.storageDir, blob.storageKey)))
  ) {
    blob = await deps.prisma.storedBlob.update({
      where: { id: blob.id },
      data: {
        storageKey: stored.storageKey,
        sizeBytes: stored.sizeBytes,
        storedBytes: stored.storedBytes,
        contentEncoding: stored.contentEncoding,
        deleteAfter: null,
        state: "READY",
        ...(input.purpose === "LINK_PREVIEW" ? { purpose: "LINK_PREVIEW" } : {}),
      },
    });
  } else if (blob) {
    await removeStored(deps.storageDir, stored.storageKey);
    if (blob.deleteAfter || (input.purpose === "LINK_PREVIEW" && blob.purpose !== "LINK_PREVIEW")) {
      blob = await deps.prisma.storedBlob.update({
        where: { id: blob.id },
        data: {
          deleteAfter: null,
          state: "READY",
          ...(input.purpose === "LINK_PREVIEW" ? { purpose: "LINK_PREVIEW" } : {}),
        },
      });
    }
  } else {
    try {
      blob = await deps.prisma.storedBlob.create({
        data: {
          id: provisionalId,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          storedBytes: stored.storedBytes,
          contentEncoding: stored.contentEncoding,
          storageKey: stored.storageKey,
          purpose: input.purpose ?? "ASSET",
          state: "READY",
        },
      });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      await removeStored(deps.storageDir, stored.storageKey);
      blob = await deps.prisma.storedBlob.findUnique({ where: { sha256: stored.sha256 } });
      if (!blob) throw err;
    }
  }
  return { blob, stored, preparation };
}

const ownerUploadTails = new Map<string, Promise<void>>();

/**
 * Serialize quota admission per owner. The critical section includes the
 * usage read, stream write and asset rows, so a second upload observes the
 * first one rather than the same stale byte count.
 */
async function withOwnerUploadAdmission<T>(ownerUserId: string, work: () => Promise<T>) {
  const previous = ownerUploadTails.get(ownerUserId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  ownerUploadTails.set(ownerUserId, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (ownerUploadTails.get(ownerUserId) === current) ownerUploadTails.delete(ownerUserId);
  }
}

/**
 * How many bytes of disk this owner's documents AND board images (NIL-381)
 * occupy, combined -- one quota pool, not two. Counted per blob and by what
 * is actually written, so an owner who put the same file on two boards (or
 * the same image both as a document and pasted onto a canvas) pays for it
 * once, and a file stored compressed costs what it costs rather than what it
 * would have cost.
 */
export async function usedBytesFor(prisma: any, ownerUserId: string): Promise<number> {
  const [assets, drawingFiles] = await Promise.all([
    prisma.asset.findMany({
      where: { ownerUserId },
      select: { blobId: true, blob: { select: { storedBytes: true } } },
    }),
    prisma.drawingFile.findMany({
      where: { ownerUserId },
      select: { blobId: true, blob: { select: { storedBytes: true } } },
    }),
  ]);
  const byBlob = new Map<string, number>();
  for (const asset of assets) byBlob.set(asset.blobId, asset.blob?.storedBytes ?? 0);
  for (const file of drawingFiles) byBlob.set(file.blobId, file.blob?.storedBytes ?? 0);
  return [...byBlob.values()].reduce((sum, bytes) => sum + bytes, 0);
}

export type CreateAssetInput = {
  ownerUserId: string;
  uploadedByUserId: string | null;
  drawingId: string;
  kind: AssetKind;
  originalName: string;
  mimeType: string;
  source: Readable;
  /**
   * Optionally rebuild the provisional bytes before content-addressed
   * deduplication. Metadata is always re-derived by this service afterwards.
   */
  prepareStored?: (
    stored: Readonly<StoredFile & { path: string }>,
  ) => Promise<{ note: string | null }>;
};

/**
 * Take an upload, store it, and attach it to a board as pending.
 *
 * Pending rather than active because the board that refers to it has not been
 * saved yet. If that save never happens — the tab is closed, the upload is
 * cancelled — the sweep below removes it rather than keeping a file nobody can
 * reach.
 */
export async function createAsset(deps: Deps, input: CreateAssetInput) {
  return withOwnerUploadAdmission(input.ownerUserId, () => createAssetAdmitted(deps, input));
}

async function createAssetAdmitted(deps: Deps, input: CreateAssetInput) {
  const now = deps.now?.() ?? Date.now();

  const used = await usedBytesFor(deps.prisma, input.ownerUserId);
  if (used >= deps.maxPerUserBytes) {
    throw new QuotaExceededError(used, deps.maxPerUserBytes);
  }

  // The file is written before its hash is known, so it lands under a
  // provisional id. If those exact bytes turn out to be on disk already, the
  // provisional copy is thrown away and the existing one reused.
  const { blob, stored, preparation } = await storeBlob(deps, {
    source: input.source,
    limitBytes: Math.min(deps.maxUploadBytes, deps.maxPerUserBytes - used),
    compress: shouldCompress(input.mimeType),
    prepareStored: input.prepareStored,
  });

  const asset = await deps.prisma.asset.create({
    data: {
      ownerUserId: input.ownerUserId,
      uploadedByUserId: input.uploadedByUserId,
      blobId: blob.id,
      kind: input.kind,
      originalName: input.originalName.slice(0, 255),
      mimeType: input.mimeType,
      status: "READY",
    },
  });

  await deps.prisma.drawingAsset.create({
    data: {
      drawingId: input.drawingId,
      assetId: asset.id,
      state: "PENDING",
      expiresAt: new Date(now + PENDING_TTL_MS),
    },
  });

  return {
    asset,
    blob,
    sizeBytes: stored.sizeBytes,
    storedBytes: stored.storedBytes,
    note: preparation?.note ?? null,
  };
}

export type StoreDrawingFileInput = {
  drawingId: string;
  fileId: string;
  ownerUserId: string;
  mimeType: string;
  source: Readable;
};

/**
 * Store a board image's bytes and bind them to (drawingId, fileId) (NIL-381).
 *
 * Idempotent by design, not by a special case: the same bytes uploaded twice
 * dedupe to the same blob in storeBlob, and upserting the DrawingFile row
 * with that same blobId is a no-op write. Different bytes under the same
 * fileId (a re-upload) simply repoint the reference at the new blob -- this
 * should be rare, since Excalidraw fileIds are themselves content hashes,
 * but is not treated as an error.
 *
 * No DrawingAsset-style PENDING state: unlike a document, an image upload is
 * always in direct response to the client about to reference it (a paste, a
 * drop, the background uploader flushing a queued file), never a
 * maybe-referenced-later upload flow. A row nothing ends up referencing is
 * cleaned up the same way an orphaned S3File row is today -- through the
 * existing files/orphans flow (routes/storage.ts), not a second pending-TTL
 * mechanism.
 */
export async function storeDrawingFile(deps: Deps, input: StoreDrawingFileInput) {
  return withOwnerUploadAdmission(input.ownerUserId, () => storeDrawingFileAdmitted(deps, input));
}

async function storeDrawingFileAdmitted(deps: Deps, input: StoreDrawingFileInput) {
  const used = await usedBytesFor(deps.prisma, input.ownerUserId);
  if (used >= deps.maxPerUserBytes) {
    throw new QuotaExceededError(used, deps.maxPerUserBytes);
  }

  const { blob, stored } = await storeBlob(deps, {
    source: input.source,
    limitBytes: Math.min(deps.maxUploadBytes, deps.maxPerUserBytes - used),
    compress: shouldCompress(input.mimeType),
    purpose: "IMAGE",
  });

  const drawingFile = await deps.prisma.drawingFile.upsert({
    where: { drawingId_fileId: { drawingId: input.drawingId, fileId: input.fileId } },
    create: {
      drawingId: input.drawingId,
      fileId: input.fileId,
      blobId: blob.id,
      ownerUserId: input.ownerUserId,
      mimeType: input.mimeType,
    },
    update: {
      blobId: blob.id,
      ownerUserId: input.ownerUserId,
      mimeType: input.mimeType,
    },
  });

  return { drawingFile, blob, sizeBytes: stored.sizeBytes, storedBytes: stored.storedBytes };
}

/**
 * Point a new board at the same board images an existing one has (NIL-503
 * review fix, board duplicate).
 *
 * Never copies bytes: DrawingFile rows are content-addressed references, so
 * duplicating a board only ever needs a second reference row at the same
 * blobId -- the same reasoning storeDrawingFile's own idempotent upsert
 * relies on. `ownerUserId` is the target board's owner (whoever ends up
 * charged for the quota), not necessarily who is clicking "duplicate".
 */
export async function cloneDrawingFiles(
  prisma: any,
  sourceDrawingId: string,
  targetDrawingId: string,
  ownerUserId: string,
): Promise<string[]> {
  const records = await prisma.drawingFile.findMany({ where: { drawingId: sourceDrawingId } });
  if (records.length === 0) return [];

  await Promise.all(
    records.map((record: { fileId: string; blobId: string; mimeType: string }) =>
      prisma.drawingFile.upsert({
        where: { drawingId_fileId: { drawingId: targetDrawingId, fileId: record.fileId } },
        create: {
          drawingId: targetDrawingId,
          fileId: record.fileId,
          blobId: record.blobId,
          ownerUserId,
          mimeType: record.mimeType,
        },
        update: {
          blobId: record.blobId,
          ownerUserId,
          mimeType: record.mimeType,
        },
      }),
    ),
  );

  return records.map((record: { fileId: string }) => record.fileId);
}

/**
 * Reconcile a board's documents with what its elements actually refer to.
 *
 * Called from the save, inside the same transaction, so a board and its
 * document list can never disagree. Ids the board does not own are refused
 * rather than ignored: a client naming someone else's asset is not a mistake to
 * paper over.
 */
export async function syncDrawingAssets(
  prisma: any,
  drawingId: string,
  referencedAssetIds: string[],
): Promise<{ activated: string[]; detached: string[] }> {
  const wanted = [...new Set(referencedAssetIds)];
  const existing = await prisma.drawingAsset.findMany({ where: { drawingId } });
  const known = new Set(existing.map((row: any) => row.assetId));

  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new StaleDrawingAssetReferenceError(
      `This board does not have ${unknown.length === 1 ? "a document" : "documents"} ` +
        `with id ${unknown.map((id) => `"${id}"`).join(", ")}. Upload the file to this board first.`,
      unknown,
    );
  }

  const activated: string[] = [];
  for (const row of existing) {
    if (wanted.includes(row.assetId) && row.state !== "ACTIVE") {
      await prisma.drawingAsset.update({
        where: { drawingId_assetId: { drawingId, assetId: row.assetId } },
        data: { state: "ACTIVE", expiresAt: null },
      });
      activated.push(row.assetId);
    }
  }

  // Removing the widget from the board detaches the document. The bytes stay
  // until nothing — not even a snapshot — refers to them.
  const detached = existing
    .filter((row: any) => row.state === "ACTIVE" && !wanted.includes(row.assetId))
    .map((row: any) => row.assetId);
  for (const assetId of detached) {
    await prisma.drawingAsset.delete({
      where: { drawingId_assetId: { drawingId, assetId } },
    });
  }

  return { activated, detached };
}

/**
 * Record which documents a snapshot needs.
 *
 * Without this, restoring an old version would bring back elements pointing at
 * documents that were swept away in the meantime.
 */
export async function captureSnapshotAssets(
  prisma: any,
  snapshotId: string,
  drawingId: string,
): Promise<string[]> {
  const active = await prisma.drawingAsset.findMany({
    where: { drawingId, state: "ACTIVE" },
    select: { assetId: true },
  });
  for (const row of active) {
    await prisma.drawingSnapshotAsset.create({
      data: { snapshotId, assetId: row.assetId },
    });
  }
  return active.map((row: any) => row.assetId);
}

/**
 * Remove uploads no save ever claimed, then mark bytes nothing refers to.
 *
 * Deliberately two steps with a grace period between them: a board deleted by
 * mistake and restored from a snapshot should still find its documents.
 */
export async function sweepUnclaimed(deps: Deps): Promise<{ pending: number; marked: number }> {
  const now = deps.now?.() ?? Date.now();

  const stale = await deps.prisma.drawingAsset.findMany({
    where: { state: "PENDING", expiresAt: { lt: new Date(now) } },
    select: { drawingId: true, assetId: true },
  });
  for (const row of stale) {
    await deps.prisma.drawingAsset.delete({
      where: { drawingId_assetId: { drawingId: row.drawingId, assetId: row.assetId } },
    });
  }

  const orphans = await deps.prisma.asset.findMany({
    where: { drawings: { none: {} }, snapshots: { none: {} }, deleteAfter: null },
    select: { id: true },
  });
  for (const row of orphans) {
    await deps.prisma.asset.update({
      where: { id: row.id },
      data: { deleteAfter: new Date(now + BLOB_GRACE_MS) },
    });
  }

  // A blob only a DrawingFile ever pointed at has no Asset row to carry a
  // grace period for it -- DrawingFile itself deliberately has none (see
  // storeDrawingFile's docstring). StoredBlob.deleteAfter exists precisely
  // for this ("set when the last reference goes away"); collectExpired
  // below already knows how to recheck and remove a blob marked here, the
  // same way it rechecks one an expired Asset touched.
  const orphanBlobs = await deps.prisma.storedBlob.findMany({
    where: {
      deleteAfter: null,
      state: "READY",
      assets: { none: {} },
      drawingFiles: { none: {} },
      linkPreviewImages: { none: {} },
      linkPreviewFavicons: { none: {} },
    },
    select: { id: true },
  });
  for (const row of orphanBlobs) {
    await deps.prisma.storedBlob.update({
      where: { id: row.id },
      data: { deleteAfter: new Date(now + BLOB_GRACE_MS) },
    });
  }

  return { pending: stale.length, marked: orphans.length + orphanBlobs.length };
}

/** Delete assets whose grace period has run out, and the bytes they were the last to hold. */
export async function collectExpired(deps: Deps): Promise<{ assets: number; blobs: number }> {
  const now = deps.now?.() ?? Date.now();

  const expired = await deps.prisma.asset.findMany({
    where: { deleteAfter: { lt: new Date(now) }, drawings: { none: {} }, snapshots: { none: {} } },
    select: { id: true, blobId: true },
  });
  for (const asset of expired) {
    await deps.prisma.asset.delete({ where: { id: asset.id } });
  }

  // Two ways a blob becomes a candidate: an expired Asset touched it, or its
  // own deleteAfter (set by sweepUnclaimed, above, for a blob only a
  // DrawingFile ever pointed at) has itself run out. Either way the same
  // recheck below decides whether it is actually safe to remove.
  const expiredBlobs = await deps.prisma.storedBlob.findMany({
    where: { deleteAfter: { lt: new Date(now) } },
    select: { id: true },
  });
  const touchedBlobs = [
    ...new Set([...expired.map((a: any) => a.blobId), ...expiredBlobs.map((b: any) => b.id)]),
  ] as string[];
  let removed = 0;
  for (const blobId of touchedBlobs) {
    const stillUsed = await deps.prisma.asset.count({ where: { blobId } });
    const usedByPreview = await deps.prisma.linkPreview.count({
      where: { OR: [{ imageBlobId: blobId }, { faviconBlobId: blobId }] },
    });
    // A blob a DrawingFile row still points at (NIL-381) is exactly as live
    // as one an Asset row points at -- the same "somebody else still needs
    // these bytes" check the Asset/LinkPreview counts already make, extended
    // to the reference kind this function did not know about before.
    const usedByDrawingFile = await deps.prisma.drawingFile.count({ where: { blobId } });
    if (stillUsed > 0 || usedByPreview > 0 || usedByDrawingFile > 0) continue;
    const blob = await deps.prisma.storedBlob.findUnique({ where: { id: blobId } });
    if (!blob) continue;
    // Disk first, row second: a missing file with a row left over is a broken
    // document, a row-less file is a byte on disk the sweep can find again.
    await removeStored(deps.storageDir, blob.storageKey);
    await deps.prisma.storedBlob.delete({ where: { id: blobId } });
    removed += 1;
  }

  return { assets: expired.length, blobs: removed };
}

export { AssetTooLargeError };
