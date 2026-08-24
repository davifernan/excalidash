import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import express from "express";
import JSZip from "jszip";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../generated/client";
import { createAsset } from "../../assets/assetService";
import { registerAssetRoutes } from "../../assets/assetRoutes";
import { resolveStoragePath } from "../../assets/assetStorage";
import { createSqliteBackup } from "../../backups/scheduler";
import { createTestUser, getTestPrisma, setupTestDb } from "../../__tests__/testUtils";
import { sanitizeText, validateImportedDrawing } from "../../security";
import { encodeSnapshotField } from "../../snapshots/snapshotCodec";
import { registerExcalidashImportRoutes } from "./excalidashImportRoutes";
import { registerExcalidashExportRoute } from "./exportRoutes";
import { processEmbeddedImages } from "../../fileProcessing";

const MIB = 1024 * 1024;

describe("document backup and export round trip", () => {
  let prisma: PrismaClient;
  let root: string;
  let uploadDir: string;
  let assetStorageDir: string;

  const clearDatabase = async () => {
    await prisma.drawingSnapshotAsset.deleteMany({});
    await prisma.drawingAsset.deleteMany({});
    await prisma.drawingSnapshot.deleteMany({});
    await prisma.asset.deleteMany({});
    await prisma.storedBlob.deleteMany({});
    await prisma.drawing.deleteMany({});
    await prisma.collection.deleteMany({});
    await prisma.user.deleteMany({});
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
  });

  beforeEach(async () => {
    await clearDatabase();
    root = await fs.mkdtemp(join(tmpdir(), "asset-roundtrip-"));
    uploadDir = join(root, "uploads");
    assetStorageDir = join(root, "assets");
    await fs.mkdir(uploadDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await clearDatabase();
    await prisma.$disconnect();
  });

  const routeHarness = () => {
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
    const deps = {
      app,
      prisma,
      requireAuth: (_req: any, _res: any, next: any) => next(),
      asyncHandler: (handler: any) => handler,
      upload: { single: () => (_req: any, _res: any, next: any) => next() },
      uploadDir,
      assetStorageDir,
      backendRoot: resolve(__dirname, "../../.."),
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
      processEmbeddedImages: (files: Record<string, any>, userId: string, drawingId: string) =>
        processEmbeddedImages(
          { prisma, storageDir: assetStorageDir, maxUploadBytes: 5 * MIB, maxPerUserBytes: 20 * MIB },
          files,
          userId,
          drawingId,
        ),
      MAX_IMPORT_ARCHIVE_ENTRIES: 100,
      MAX_IMPORT_ARCHIVE_BYTES: 20 * MIB,
      MAX_IMPORT_COLLECTIONS: 10,
      MAX_IMPORT_DRAWINGS: 10,
      MAX_IMPORT_MANIFEST_BYTES: MIB,
      MAX_IMPORT_DRAWING_BYTES: MIB,
      MAX_IMPORT_ENTRY_BYTES: 5 * MIB,
      MAX_IMPORT_TOTAL_EXTRACTED_BYTES: 10 * MIB,
    } as any;
    registerExcalidashExportRoute(deps);
    registerExcalidashImportRoutes(deps);
    return { exportHandler, importHandler };
  };

  const exportArchive = async (handler: any, userId: string) => {
    const response = new PassThrough() as PassThrough & Record<string, any>;
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.setHeader = () => response;
    response.status = (status: number) => {
      response.statusCode = status;
      return response;
    };
    response.json = (body: unknown) => {
      response.body = body;
      response.end();
      return response;
    };
    const ended = new Promise<void>((done) => response.on("end", done));
    await handler(
      { user: { id: userId }, query: {}, protocol: "https", get: () => "example.test" },
      response,
    );
    await ended;
    return Buffer.concat(chunks);
  };

  it("imports its own export after upload optimization changes the PDF hash", async () => {
    const user = await createTestUser(prisma, "roundtrip@example.com");
    const drawing = await prisma.drawing.create({
      data: { name: "PDF board", elements: "[]", appState: "{}", userId: user.id },
    });
    const uploadedPdf = Buffer.from(`%PDF-1.4\n${"redundant upload bytes\n".repeat(20)}%%EOF\n`);
    const optimizedPdf = Buffer.from("%PDF-1.4\noptimized integration document\n%%EOF\n");
    const uploadApp = express();
    const asyncHandler = (handler: any) => (req: any, res: any, next: any) =>
      Promise.resolve(handler(req, res, next)).catch(next);
    const auth = (req: any, _res: any, next: any) => {
      req.user = { id: user.id };
      next();
    };
    registerAssetRoutes({
      app: uploadApp,
      prisma,
      requireAuth: auth,
      optionalAuth: auth,
      asyncHandler,
      storageDir: assetStorageDir,
      maxUploadBytes: MIB,
      maxPerUserBytes: 5 * MIB,
      getPage: async () => {
        throw new Error("not used");
      },
      describeUpload: async () => ({ pageCount: 1 }),
      optimizeUpload: async ({ path }) => {
        await fs.writeFile(path, optimizedPdf);
        return { note: "optimized" };
      },
    });
    const uploadResponse = await request(uploadApp)
      .post(`/drawings/${drawing.id}/assets?name=proof.pdf`)
      .set("Content-Type", "application/pdf")
      .send(uploadedPdf)
      .expect(201);
    expect(uploadResponse.body.sizeBytes).toBeLessThan(uploadedPdf.length);
    const uploadedAsset = await prisma.asset.findUnique({
      where: { id: uploadResponse.body.id },
      include: { blob: true },
    });
    expect(uploadedAsset).toBeTruthy();
    const created = { asset: uploadedAsset!, blob: uploadedAsset!.blob };
    const elements = [
      {
        id: "pdf-widget",
        customData: {
          excalidash: {
            schemaVersion: 2,
            widget: { kind: "pdf", assetId: created.asset.id },
          },
          // A foreign key on the same element, to prove the remap reaches past
          // it rather than being confused by it.
          note: "x".repeat(2000),
        },
      },
    ];
    await prisma.drawing.update({
      where: { id: drawing.id },
      data: { elements: JSON.stringify(elements) },
    });
    await prisma.drawingAsset.update({
      where: { drawingId_assetId: { drawingId: drawing.id, assetId: created.asset.id } },
      data: { state: "ACTIVE", expiresAt: null },
    });
    const snapshot = await prisma.drawingSnapshot.create({
      data: {
        drawingId: drawing.id,
        version: 1,
        elements: encodeSnapshotField(JSON.stringify(elements), true),
        appState: encodeSnapshotField("{}", true),
        files: encodeSnapshotField("{}", true),
      },
    });
    await prisma.drawingSnapshotAsset.create({
      data: { snapshotId: snapshot.id, assetId: created.asset.id },
    });

    const { exportHandler, importHandler } = routeHarness();
    const archive = await exportArchive(exportHandler, user.id);
    const parsedArchive = await JSZip.loadAsync(archive);
    const manifest = JSON.parse(
      await parsedArchive.file("excalidash.manifest.json")!.async("string"),
    );
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.blobs[0].sha256).toBe(created.blob.sha256);
    expect(await parsedArchive.file(manifest.blobs[0].filePath)!.async("nodebuffer")).toEqual(
      optimizedPdf,
    );

    await prisma.drawing.delete({ where: { id: drawing.id } });
    await prisma.asset.delete({ where: { id: created.asset.id } });
    await prisma.storedBlob.delete({ where: { id: created.blob.id } });
    await fs.rm(join(assetStorageDir, "originals"), { recursive: true, force: true });

    const stagedFilename = "b".repeat(32);
    await fs.writeFile(join(uploadDir, stagedFilename), archive);
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
    await importHandler({ user: { id: user.id }, file: { filename: stagedFilename } }, response);
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);

    const restoredDrawing = await prisma.drawing.findUnique({ where: { id: drawing.id } });
    const restoredAsset = await prisma.asset.findFirst({
      include: { blob: true, drawings: true, snapshots: true },
    });
    expect(restoredDrawing).toBeTruthy();
    expect(restoredAsset?.originalName).toBe("proof.pdf");
    expect(restoredAsset?.drawings).toHaveLength(1);
    expect(restoredAsset?.snapshots).toHaveLength(1);
    expect(JSON.parse(restoredDrawing!.elements)[0].customData.excalidash.widget.assetId).toBe(
      restoredAsset!.id,
    );
    const restoredBytes = await fs.readFile(
      resolveStoragePath(assetStorageDir, restoredAsset!.blob.storageKey),
    );
    expect(restoredBytes).toEqual(optimizedPdf);
  });

  it("scheduled backup stores SQLite and originals but excludes the render cache", async () => {
    const user = await createTestUser(prisma, "scheduled@example.com");
    const drawing = await prisma.drawing.create({
      data: { name: "Scheduled", elements: "[]", appState: "{}", userId: user.id },
    });
    const bytes = Buffer.from("scheduled original");
    const created = await createAsset(
      { prisma, storageDir: assetStorageDir, maxUploadBytes: MIB, maxPerUserBytes: 5 * MIB },
      {
        ownerUserId: user.id,
        uploadedByUserId: user.id,
        drawingId: drawing.id,
        kind: "PDF",
        originalName: "scheduled.pdf",
        mimeType: "application/pdf",
        source: Readable.from([bytes]),
      },
    );
    const cachePath = resolveStoragePath(assetStorageDir, "cache/asset/page.svg");
    await fs.mkdir(join(assetStorageDir, "cache/asset"), { recursive: true });
    await fs.writeFile(cachePath, "recomputable");
    const backupDir = join(root, "backups");

    const target = await createSqliteBackup({
      prisma,
      databaseUrl: process.env.DATABASE_URL,
      backupDir,
      assetStorageDir,
      retentionDays: 14,
    });
    expect(target).toBeTruthy();
    const archive = await JSZip.loadAsync(await fs.readFile(target!));
    expect(archive.file("database.sqlite")).toBeTruthy();
    expect(await archive.file(`assets/${created.blob.storageKey}`)!.async("nodebuffer")).toEqual(
      bytes,
    );
    expect(Object.keys(archive.files).some((name) => name.includes("/cache/"))).toBe(false);
  });
});
