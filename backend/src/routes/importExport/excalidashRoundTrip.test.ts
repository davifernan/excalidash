import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeText, validateImportedDrawing } from "../../security";
import { registerExcalidashExportRoute } from "./exportRoutes";
import { registerExcalidashImportRoutes } from "./excalidashImportRoutes";

const MIB = 1024 * 1024;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("ExcaliDash backup round trip", () => {
  it("exports and re-imports a drawing whose JSON is larger than 5 MiB", async () => {
    const uploadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "excalidash-import-"));
    tempDirs.push(uploadDir);
    const now = new Date("2026-08-20T12:00:00.000Z");
    const largeDataUrl = `data:image/png;base64,${"A".repeat(6 * MIB)}`;
    const exportedDrawing = {
      id: "drawing-large",
      name: "Large embedded image",
      elements: "[]",
      appState: "{}",
      files: JSON.stringify({ image: { dataURL: largeDataUrl, mimeType: "image/png" } }),
      preview: null,
      version: 1,
      userId: "user-1",
      collectionId: null,
      collection: null,
      createdAt: now,
      updatedAt: now,
    };
    const imported: Array<Record<string, unknown>> = [];
    const drawingFindManyArgs: any[] = [];
    let drawingFindUniqueCalls = 0;
    const tx = {
      collection: {
        findUnique: async () => null,
        create: async () => undefined,
        update: async () => undefined,
      },
      storedBlob: {
        create: async () => undefined,
        update: async () => undefined,
      },
      asset: { create: async () => undefined },
      drawingAsset: {
        create: async () => undefined,
        deleteMany: async () => undefined,
      },
      drawingSnapshot: { create: async () => undefined },
      drawingSnapshotAsset: { create: async () => undefined },
      drawing: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          imported.push(data);
          return data;
        },
        update: async () => undefined,
      },
    };
    const prisma = {
      drawing: {
        findMany: async (args: any) => {
          drawingFindManyArgs.push(args);
          return [exportedDrawing];
        },
        findUnique: async () => {
          drawingFindUniqueCalls += 1;
          return exportedDrawing;
        },
      },
      collection: {
        findMany: async () => [],
        findFirst: async () => null,
      },
      drawingAsset: { findMany: async () => [] },
      drawingFile: { findMany: async () => [] },
      drawingSnapshot: { findMany: async () => [] },
      storedBlob: { findUnique: async () => null },
      s3File: {},
      $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
    } as any;
    let exportHandler: any;
    let importHandler: any;
    const app = {
      get: (_route: string, ...handlers: any[]) => {
        exportHandler = handlers.at(-1);
      },
      post: (route: string, ...handlers: any[]) => {
        if (route === "/import/excalidash") importHandler = handlers.at(-1);
      },
    };
    const requireAuth = (_req: any, _res: any, next: any) => next();
    const asyncHandler = (handler: any) => handler;
    const deps = {
      app,
      prisma,
      requireAuth,
      asyncHandler,
      upload: { single: () => (_req: any, _res: any, next: any) => next() },
      uploadDir,
      assetStorageDir: uploadDir,
      backendRoot: path.resolve(__dirname, "../../.."),
      getBackendVersion: () => "test",
      parseJsonField: (raw: string | null | undefined, fallback: unknown) =>
        raw ? JSON.parse(raw) : fallback,
      sanitizeText,
      validateImportedDrawing,
      ensureTrashCollection: async () => undefined,
      invalidateDrawingsCache: () => undefined,
      removeFileIfExists: async (filePath?: string) => {
        if (filePath) await fs.promises.rm(filePath, { force: true });
      },
      verifyDatabaseIntegrityAsync: async () => true,
      // This harness's prisma is hand-mocked, not a real blob store -- this
      // test is about the backup/export/import round trip, not image
      // processing, so a passthrough is the same "leave files as they are"
      // the old isS3Enabled=false default gave it.
      processEmbeddedImages: async (files: Record<string, unknown>) => files,
      MAX_IMPORT_ARCHIVE_ENTRIES: 6000,
      MAX_IMPORT_ARCHIVE_BYTES: 100 * MIB,
      MAX_IMPORT_COLLECTIONS: 1000,
      MAX_IMPORT_DRAWINGS: 5000,
      MAX_IMPORT_MANIFEST_BYTES: 2 * MIB,
      MAX_IMPORT_DRAWING_BYTES: 100 * MIB,
      MAX_IMPORT_ENTRY_BYTES: 100 * MIB,
      MAX_IMPORT_TOTAL_EXTRACTED_BYTES: 120 * MIB,
    };
    registerExcalidashExportRoute(deps);
    registerExcalidashImportRoutes(deps);

    const exportResponse = new PassThrough() as PassThrough & Record<string, any>;
    const chunks: Buffer[] = [];
    exportResponse.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    exportResponse.setHeader = () => exportResponse;
    exportResponse.status = (status: number) => {
      exportResponse.statusCode = status;
      return exportResponse;
    };
    exportResponse.json = (body: unknown) => {
      exportResponse.body = body;
      exportResponse.end();
      return exportResponse;
    };
    const exportEnded = new Promise<void>((resolve) => exportResponse.on("end", resolve));
    await exportHandler(
      {
        user: { id: "user-1", email: "owner@example.com", role: "USER" },
        query: {},
        protocol: "https",
        get: () => "draw.example.com",
      },
      exportResponse,
    );
    await exportEnded;
    const archive = Buffer.concat(chunks);
    expect(archive.length).toBeGreaterThan(0);
    expect(drawingFindManyArgs[0].select).not.toHaveProperty("elements");
    expect(drawingFindManyArgs[0].select).not.toHaveProperty("files");
    // One bounded preflight read and one lazy archive-stream read. The full
    // scene is never part of the all-drawings metadata query.
    expect(drawingFindUniqueCalls).toBeGreaterThanOrEqual(2);

    const stagedFilename = "a".repeat(32);
    await fs.promises.writeFile(path.join(uploadDir, stagedFilename), archive);
    const importResponse: Record<string, any> = {
      statusCode: 200,
      status(status: number) {
        this.statusCode = status;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    await importHandler(
      {
        user: { id: "user-1", email: "owner@example.com", role: "USER" },
        file: { filename: stagedFilename },
      },
      importResponse,
    );

    expect(importResponse.statusCode, JSON.stringify(importResponse.body)).toBe(200);
    expect(imported).toHaveLength(1);
    expect(Buffer.byteLength(exportedDrawing.files, "utf8")).toBeGreaterThan(5 * MIB);
    expect(JSON.parse(imported[0].files as string).image.dataURL).toBe(largeDataUrl);
  }, 30_000);
});
