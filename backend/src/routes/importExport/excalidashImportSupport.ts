import { createHash } from "node:crypto";
import { NAMESPACE, readWidgetRecord } from "../../assets/customDataSchema";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ExcalidashManifest,
  ImportValidationError,
  RegisterImportExportDeps,
  excalidashManifestSchema,
  findFirstDuplicate,
  sanitizeDrawingData,
} from "./shared";
import { ExtractionBudget, StreamingZipArchive, StreamingZipEntry } from "./streamingZip";

export type PreparedDrawing = {
  id: string;
  name: string;
  version: number | undefined;
  collectionId: string | null;
  sanitized: ReturnType<typeof sanitizeDrawingData>;
};

export type PreparedSnapshot = {
  id: string;
  drawingId: string;
  version: number;
  createdAt?: string;
  assetIds: string[];
  sanitized: ReturnType<typeof sanitizeDrawingData>;
};

export const parseManifest = async (
  archive: StreamingZipArchive,
  budget: ExtractionBudget,
  maxManifestBytes: number,
): Promise<ExcalidashManifest> => {
  const entry = archive.get("excalidash.manifest.json");
  if (!entry) throw new ImportValidationError("Missing excalidash.manifest.json");
  const raw = await archive.readBuffer(entry, maxManifestBytes, budget);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ImportValidationError("excalidash.manifest.json is not valid JSON");
  }
  const parsed = excalidashManifestSchema.safeParse(json);
  if (!parsed.success) throw new ImportValidationError("Malformed excalidash.manifest.json");
  return parsed.data;
};

export const requireEntry = (archive: StreamingZipArchive, filePath: string): StreamingZipEntry => {
  const entry = archive.get(filePath);
  if (!entry || entry.directory)
    throw new ImportValidationError(`Missing archive file: ${filePath}`);
  return entry;
};

export const validateManifestReferences = (
  archive: StreamingZipArchive,
  manifest: ExcalidashManifest,
  limits: Pick<RegisterImportExportDeps, "MAX_IMPORT_COLLECTIONS" | "MAX_IMPORT_DRAWINGS">,
) => {
  if (manifest.collections.length > limits.MAX_IMPORT_COLLECTIONS) {
    throw new ImportValidationError(`Too many collections (max ${limits.MAX_IMPORT_COLLECTIONS})`);
  }
  if (manifest.drawings.length > limits.MAX_IMPORT_DRAWINGS) {
    throw new ImportValidationError(`Too many drawings (max ${limits.MAX_IMPORT_DRAWINGS})`);
  }
  const duplicateCollectionId = findFirstDuplicate(manifest.collections.map((item) => item.id));
  if (duplicateCollectionId)
    throw new ImportValidationError(`Duplicate collection id: ${duplicateCollectionId}`);
  const duplicateDrawingId = findFirstDuplicate(manifest.drawings.map((item) => item.id));
  if (duplicateDrawingId)
    throw new ImportValidationError(`Duplicate drawing id: ${duplicateDrawingId}`);
  const duplicateDrawingPath = findFirstDuplicate(manifest.drawings.map((item) => item.filePath));
  if (duplicateDrawingPath)
    throw new ImportValidationError(`Duplicate drawing path: ${duplicateDrawingPath}`);
  for (const drawing of manifest.drawings) requireEntry(archive, drawing.filePath);

  if (manifest.formatVersion === 1) return;
  const duplicateBlobId = findFirstDuplicate(manifest.blobs.map((item) => item.id));
  const duplicateBlobHash = findFirstDuplicate(manifest.blobs.map((item) => item.sha256));
  const duplicateBlobPath = findFirstDuplicate(manifest.blobs.map((item) => item.filePath));
  const duplicateAssetId = findFirstDuplicate(manifest.assets.map((item) => item.id));
  const duplicateSnapshotId = findFirstDuplicate(manifest.snapshots.map((item) => item.id));
  const duplicateSnapshotPath = findFirstDuplicate(manifest.snapshots.map((item) => item.filePath));
  if (duplicateBlobId) throw new ImportValidationError(`Duplicate blob id: ${duplicateBlobId}`);
  if (duplicateBlobHash)
    throw new ImportValidationError(`Duplicate blob sha256: ${duplicateBlobHash}`);
  if (duplicateBlobPath)
    throw new ImportValidationError(`Duplicate blob path: ${duplicateBlobPath}`);
  if (duplicateAssetId) throw new ImportValidationError(`Duplicate asset id: ${duplicateAssetId}`);
  if (duplicateSnapshotId)
    throw new ImportValidationError(`Duplicate snapshot id: ${duplicateSnapshotId}`);
  if (duplicateSnapshotPath)
    throw new ImportValidationError(`Duplicate snapshot path: ${duplicateSnapshotPath}`);

  const drawingIds = new Set(manifest.drawings.map((item) => item.id));
  const blobIds = new Set(manifest.blobs.map((item) => item.id));
  const assetIds = new Set(manifest.assets.map((item) => item.id));
  for (const blob of manifest.blobs) {
    const entry = requireEntry(archive, blob.filePath);
    if (entry.uncompressedSize !== blob.sizeBytes) {
      throw new ImportValidationError(`Document size does not match manifest: ${blob.filePath}`);
    }
  }
  for (const asset of manifest.assets) {
    if (!blobIds.has(asset.blobId))
      throw new ImportValidationError(`Asset references unknown blob: ${asset.id}`);
  }
  const drawingAssetKeys = new Set<string>();
  for (const link of manifest.drawingAssets) {
    if (!drawingIds.has(link.drawingId) || !assetIds.has(link.assetId)) {
      throw new ImportValidationError("Drawing asset link references an unknown record");
    }
    const key = `${link.drawingId}\0${link.assetId}`;
    if (drawingAssetKeys.has(key)) throw new ImportValidationError("Duplicate drawing asset link");
    drawingAssetKeys.add(key);
  }
  if (manifest.formatVersion === 3) {
    const drawingFileKeys = new Set<string>();
    for (const link of manifest.drawingFiles) {
      if (!drawingIds.has(link.drawingId) || !blobIds.has(link.blobId)) {
        throw new ImportValidationError("Drawing file link references an unknown record");
      }
      const key = `${link.drawingId}\0${link.fileId}`;
      if (drawingFileKeys.has(key)) {
        throw new ImportValidationError("Duplicate drawing file link");
      }
      drawingFileKeys.add(key);
    }
  }
  for (const snapshot of manifest.snapshots) {
    requireEntry(archive, snapshot.filePath);
    if (!drawingIds.has(snapshot.drawingId)) {
      throw new ImportValidationError(`Snapshot references unknown drawing: ${snapshot.id}`);
    }
    if (findFirstDuplicate(snapshot.assetIds)) {
      throw new ImportValidationError(`Snapshot contains duplicate asset links: ${snapshot.id}`);
    }
    if (snapshot.assetIds.some((id) => !assetIds.has(id))) {
      throw new ImportValidationError(`Snapshot references unknown asset: ${snapshot.id}`);
    }
  }
};

export const assertSceneMemoryBudget = (
  archive: StreamingZipArchive,
  manifest: ExcalidashManifest,
  maxBytes: number,
): void => {
  let admittedBytes = 0;
  for (const drawing of manifest.drawings) {
    admittedBytes += requireEntry(archive, drawing.filePath).uncompressedSize;
  }
  if (manifest.formatVersion !== 1) {
    for (const snapshot of manifest.snapshots) {
      admittedBytes += requireEntry(archive, snapshot.filePath).uncompressedSize;
    }
  }
  if (admittedBytes > maxBytes) {
    throw new ImportValidationError(
      "Drawing and snapshot data exceed the safe in-memory import limit",
      413,
    );
  }
};

export const parseScene = (
  raw: Buffer,
  meta: { name: string; collectionId?: string | null },
  validateImportedDrawing: RegisterImportExportDeps["validateImportedDrawing"],
) => {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ImportValidationError("Drawing JSON is invalid");
  }
  const imported = {
    name: meta.name,
    elements: Array.isArray(parsed?.elements) ? parsed.elements : [],
    appState:
      typeof parsed?.appState === "object" && parsed.appState !== null ? parsed.appState : {},
    files: typeof parsed?.files === "object" && parsed.files !== null ? parsed.files : {},
    preview: null as string | null,
    collectionId: meta.collectionId ?? null,
  };
  if (!validateImportedDrawing(imported))
    throw new ImportValidationError("Drawing failed validation");
  return sanitizeDrawingData(imported);
};

export const verifyEntrySha256 = async (
  archive: StreamingZipArchive,
  entry: StreamingZipEntry,
  expected: string,
  budget: ExtractionBudget,
) => {
  const hash = createHash("sha256");
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(await archive.stream(entry, budget), sink);
  if (hash.digest("hex") !== expected) {
    throw new ImportValidationError(`Document sha256 mismatch: ${entry.name}`);
  }
};

/**
 * Point an imported board's widgets at the assets this instance just created.
 *
 * Reads the record through the shared schema rather than reaching for
 * `customData.assetId` directly: the ids live under this application's
 * namespace, and a remap that misses them leaves every imported widget naming a
 * document that belongs to the board it came from.
 */
export const remapAssetIds = (elements: unknown[], assetIdMap: Map<string, string>) => {
  for (const element of elements) {
    const widget = readWidgetRecord(element);
    if (!widget) continue;
    const replacement = assetIdMap.get(widget.assetId);
    if (!replacement) continue;
    const own = (element as any).customData[NAMESPACE];
    own.widget = { ...own.widget, assetId: replacement };
  }
};

export const canonicalMimeType = (kind: "PDF" | "MARKDOWN" | "TEXT") => {
  if (kind === "PDF") return "application/pdf";
  if (kind === "MARKDOWN") return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
};

export const openArchive = async (stagedPath: string, deps: RegisterImportExportDeps) =>
  StreamingZipArchive.open(stagedPath, {
    maxArchiveBytes: deps.MAX_IMPORT_ARCHIVE_BYTES,
    maxEntries: deps.MAX_IMPORT_ARCHIVE_ENTRIES,
    maxEntryBytes: deps.MAX_IMPORT_ENTRY_BYTES,
    maxExtractedBytes: deps.MAX_IMPORT_TOTAL_EXTRACTED_BYTES,
  });
