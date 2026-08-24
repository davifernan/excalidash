import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeText, validateImportedDrawing } from "../../security";
import { registerExcalidashImportRoutes } from "./excalidashImportRoutes";

const MIB = 1024 * 1024;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const makeHarness = async (overrides: Record<string, unknown> = {}) => {
  const root = await fs.mkdtemp(join(tmpdir(), "streaming-import-"));
  tempDirs.push(root);
  const uploadDir = join(root, "uploads");
  const assetStorageDir = join(root, "assets");
  await fs.mkdir(uploadDir);
  const imported: any[] = [];
  const tx = {
    storedBlob: { create: async () => undefined, update: async () => undefined },
    collection: {
      findUnique: async () => null,
      create: async () => undefined,
      update: async () => undefined,
    },
    drawing: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        imported.push(data);
      },
      update: async () => undefined,
    },
    asset: { create: async () => undefined },
    drawingAsset: { create: async () => undefined, deleteMany: async () => undefined },
    drawingSnapshot: { create: async () => undefined },
    drawingSnapshotAsset: { create: async () => undefined },
  };
  const prisma = {
    drawing: { findUnique: async () => null, update: async () => undefined },
    storedBlob: { findUnique: async () => null },
    s3File: {},
    $transaction: async (callback: any) => callback(tx),
  };
  let importHandler: any;
  const app = {
    post: (route: string, ...handlers: any[]) => {
      if (route === "/import/excalidash") importHandler = handlers.at(-1);
    },
  };
  const deps = {
    app,
    prisma,
    requireAuth: (_req: any, _res: any, next: any) => next(),
    asyncHandler: (handler: any) => handler,
    upload: { single: () => (_req: any, _res: any, next: any) => next() },
    uploadDir,
    assetStorageDir,
    backendRoot: root,
    getBackendVersion: () => "test",
    parseJsonField: (raw: string | null | undefined, fallback: unknown) =>
      raw ? JSON.parse(raw) : fallback,
    sanitizeText,
    validateImportedDrawing,
    ensureTrashCollection: async () => undefined,
    invalidateDrawingsCache: () => undefined,
    removeFileIfExists: async (filePath?: string) => {
      if (filePath) await fs.rm(filePath, { force: true });
    },
    verifyDatabaseIntegrityAsync: async () => true,
    // This harness's prisma is hand-mocked, not a real blob store -- these
    // tests are about archive/import mechanics, not image processing, so a
    // passthrough is the same "leave files as they are" the old
    // isS3Enabled=false default gave them.
    processEmbeddedImages: async (files: Record<string, unknown>) => files,
    MAX_IMPORT_ARCHIVE_ENTRIES: 100,
    MAX_IMPORT_ARCHIVE_BYTES: 10 * MIB,
    MAX_IMPORT_COLLECTIONS: 10,
    MAX_IMPORT_DRAWINGS: 10,
    MAX_IMPORT_MANIFEST_BYTES: MIB,
    MAX_IMPORT_DRAWING_BYTES: MIB,
    MAX_IMPORT_ENTRY_BYTES: MIB,
    MAX_IMPORT_TOTAL_EXTRACTED_BYTES: 5 * MIB,
    ...overrides,
  } as any;
  registerExcalidashImportRoutes(deps);

  const invoke = async (archive: Buffer) => {
    const filename = "a".repeat(32);
    await fs.writeFile(join(uploadDir, filename), archive);
    const response: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    await importHandler({ user: { id: "user-1" }, file: { filename } }, response);
    return response;
  };
  return { invoke, imported, assetStorageDir };
};

const v1Archive = async () => {
  const zip = new JSZip();
  zip.file(
    "excalidash.manifest.json",
    JSON.stringify({
      format: "excalidash",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      unorganizedFolder: "Unorganized",
      collections: [],
      drawings: [
        {
          id: "drawing-v1",
          name: "Old backup",
          filePath: "Unorganized/old.excalidraw",
          collectionId: null,
          version: 1,
        },
      ],
    }),
  );
  zip.file("Unorganized/old.excalidraw", JSON.stringify({ elements: [], appState: {}, files: {} }));
  return zip.generateAsync({ type: "nodebuffer" });
};

describe("streaming .excalidash import", () => {
  it("continues to import format-version 1 archives", async () => {
    const harness = await makeHarness();
    const response = await harness.invoke(await v1Archive());
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    expect(harness.imported).toHaveLength(1);
    expect(harness.imported[0].name).toBe("Old backup");
  });

  it("rejects scene JSON before parsing when the import working-set limit is exceeded", async () => {
    const harness = await makeHarness({ MAX_IMPORT_SCENE_MEMORY_BYTES: 32 });
    const response = await harness.invoke(await v1Archive());

    expect(response.statusCode).toBe(413);
    expect(response.body.message).toContain("safe in-memory import limit");
    expect(harness.imported).toHaveLength(0);
  });

  it("rejects an archive entry that escapes the archive root", async () => {
    const zip = new JSZip();
    const safeName = "safe/safe/namexx";
    const unsafeName = "../../etc/passwd";
    expect(Buffer.byteLength(safeName)).toBe(Buffer.byteLength(unsafeName));
    zip.file(
      "excalidash.manifest.json",
      JSON.stringify({
        format: "excalidash",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        unorganizedFolder: "Unorganized",
        collections: [],
        drawings: [],
      }),
    );
    zip.file(safeName, "do not write this");
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    let replaced = 0;
    for (
      let offset = archive.indexOf(safeName);
      offset >= 0;
      offset = archive.indexOf(safeName, offset + unsafeName.length)
    ) {
      archive.write(unsafeName, offset, "utf8");
      replaced += 1;
    }
    expect(replaced).toBeGreaterThanOrEqual(2);

    const harness = await makeHarness();
    const response = await harness.invoke(archive);
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toContain("Unsafe archive path");
  });

  it("rejects a version-2 document whose sha256 does not match", async () => {
    const bytes = Buffer.from("document");
    const zip = new JSZip();
    zip.file(
      "excalidash.manifest.json",
      JSON.stringify({
        format: "excalidash",
        formatVersion: 2,
        exportedAt: new Date().toISOString(),
        unorganizedFolder: "Unorganized",
        collections: [],
        drawings: [
          { id: "drawing", name: "Board", filePath: "board.excalidraw", collectionId: null },
        ],
        blobs: [
          {
            id: "blob",
            filePath: "assets/originals/blob",
            sha256: createHash("sha256").update("different").digest("hex"),
            sizeBytes: bytes.length,
            contentEncoding: null,
          },
        ],
        assets: [
          {
            id: "asset",
            blobId: "blob",
            kind: "PDF",
            originalName: "document.pdf",
            mimeType: "application/pdf",
            pageCount: 1,
            status: "READY",
          },
        ],
        drawingAssets: [
          { drawingId: "drawing", assetId: "asset", state: "ACTIVE", expiresAt: null },
        ],
        snapshots: [],
      }),
    );
    zip.file(
      "board.excalidraw",
      JSON.stringify({
        elements: [{ customData: { assetId: "asset" } }],
        appState: {},
        files: {},
      }),
    );
    zip.file("assets/originals/blob", bytes);

    const harness = await makeHarness();
    const response = await harness.invoke(await zip.generateAsync({ type: "nodebuffer" }));
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toContain("sha256 mismatch");
  });

  it("rejects a version-3 drawing file link whose blob is absent", async () => {
    const zip = new JSZip();
    zip.file(
      "excalidash.manifest.json",
      JSON.stringify({
        format: "excalidash",
        formatVersion: 3,
        exportedAt: new Date().toISOString(),
        unorganizedFolder: "Unorganized",
        collections: [],
        drawings: [
          { id: "drawing", name: "Board", filePath: "board.excalidraw", collectionId: null },
        ],
        blobs: [],
        assets: [],
        drawingAssets: [],
        snapshots: [],
        drawingFiles: [
          {
            drawingId: "drawing",
            fileId: "image",
            blobId: "missing-blob",
            mimeType: "image/png",
          },
        ],
      }),
    );
    zip.file("board.excalidraw", JSON.stringify({ elements: [], appState: {}, files: {} }));

    const harness = await makeHarness();
    const response = await harness.invoke(await zip.generateAsync({ type: "nodebuffer" }));
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toContain("Drawing file link references an unknown record");
  });

  it("rejects a small compressed archive whose declared extracted size exceeds the total limit", async () => {
    const zip = new JSZip();
    zip.file(
      "excalidash.manifest.json",
      JSON.stringify({
        format: "excalidash",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        unorganizedFolder: "Unorganized",
        collections: [],
        drawings: [],
      }),
    );
    zip.file("bomb.txt", Buffer.alloc(4096, "x"));
    const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(archive.length).toBeLessThan(1024);
    const harness = await makeHarness({ MAX_IMPORT_TOTAL_EXTRACTED_BYTES: 1024 });
    const response = await harness.invoke(archive);
    expect(response.statusCode).toBe(413);
    expect(response.body.message).toContain("maximum import size");
  });
});
