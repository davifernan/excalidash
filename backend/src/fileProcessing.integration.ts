/**
 * processEmbeddedImages (NIL-381), against a real database and real disk --
 * the S3 mocks the old version of this test used are gone along with the S3
 * write path itself. See assetService.integration.ts for the same reasoning
 * about why a fake would only mirror the implementation here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "./generated/client";
import { getTestPrisma, setupTestDb, cleanupTestDb, createTestUser } from "./__tests__/testUtils";
import { processEmbeddedImages } from "./fileProcessing";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

describe("processEmbeddedImages", () => {
  let prisma: PrismaClient;
  let storageDir: string;
  let ownerId: string;
  let drawingId: string;

  const deps = () => ({
    prisma,
    storageDir,
    maxUploadBytes: 1024 * 1024,
    maxPerUserBytes: 4 * 1024 * 1024,
  });

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
  });

  afterAll(async () => {
    await cleanupTestDb(prisma);
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.drawingFile.deleteMany({});
    await prisma.storedBlob.deleteMany({});
    await prisma.drawing.deleteMany({});
    await prisma.user.deleteMany({});

    storageDir = await mkdtemp(join(tmpdir(), "fileprocessing-"));
    const owner = await createTestUser(prisma, "embedded-owner@example.com");
    ownerId = owner.id;
    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", userId: ownerId },
    });
    drawingId = drawing.id;
  });

  it("moves an embedded base64 image into storage and rewrites its dataURL", async () => {
    const files = { "file-1": { id: "file-1", mimeType: "image/png", dataURL: PNG_DATA_URL } };

    const result = await processEmbeddedImages(deps(), files, ownerId, drawingId);

    expect(result["file-1"].dataURL).toBe(`/api/files/${drawingId}/file-1`);
    const stored = await prisma.drawingFile.findUnique({
      where: { drawingId_fileId: { drawingId, fileId: "file-1" } },
    });
    expect(stored?.mimeType).toBe("image/png");
  });

  it("logs the complete Prisma failure when the drawing foreign key is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const files = { "file-1": { id: "file-1", mimeType: "image/png", dataURL: PNG_DATA_URL } };

    await processEmbeddedImages(deps(), files, ownerId, "missing-drawing");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"code":"P2003"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"modelName":"DrawingFile"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"field_name":"foreign key"'));
    warn.mockRestore();
  });

  it("leaves an already-processed dataURL untouched", async () => {
    const files = {
      "file-1": { id: "file-1", mimeType: "image/png", dataURL: `/api/files/${drawingId}/file-1` },
    };
    const result = await processEmbeddedImages(deps(), files, ownerId, drawingId);
    expect(result["file-1"].dataURL).toBe(`/api/files/${drawingId}/file-1`);
    expect(await prisma.drawingFile.count()).toBe(0);
  });

  it("rejects file ids containing path traversal characters, dropping only that entry", async () => {
    const files = {
      "../../etc/passwd": { id: "../../etc/passwd", mimeType: "image/png", dataURL: PNG_DATA_URL },
      "good-id": { id: "good-id", mimeType: "image/png", dataURL: PNG_DATA_URL },
    };

    const result = await processEmbeddedImages(deps(), files, ownerId, drawingId);

    expect(result["../../etc/passwd"]).toBeUndefined();
    expect(result["good-id"].dataURL).toBe(`/api/files/${drawingId}/good-id`);
    expect(await prisma.drawingFile.count()).toBe(1);
  });

  it("skips an unsupported embedded MIME type, leaving the entry as-is", async () => {
    const hostileDataUrl =
      "data:text/html;base64," + Buffer.from("<script>x</script>").toString("base64");
    const files = { "file-1": { id: "file-1", mimeType: "text/html", dataURL: hostileDataUrl } };

    const result = await processEmbeddedImages(deps(), files, ownerId, drawingId);

    expect(result["file-1"].dataURL).toBe(hostileDataUrl);
    expect(await prisma.drawingFile.count()).toBe(0);
  });

  it("dedupes identical bytes across two fileIds into one blob", async () => {
    const files = {
      "file-1": { id: "file-1", mimeType: "image/png", dataURL: PNG_DATA_URL },
      "file-2": { id: "file-2", mimeType: "image/png", dataURL: PNG_DATA_URL },
    };

    await processEmbeddedImages(deps(), files, ownerId, drawingId);

    expect(await prisma.storedBlob.count()).toBe(1);
    expect(await prisma.drawingFile.count({ where: { drawingId } })).toBe(2);
  });

  it("handles a mix of embedded and already-hosted files, only storing the embedded one", async () => {
    const files = {
      "file-b64": { id: "file-b64", mimeType: "image/png", dataURL: PNG_DATA_URL },
      "file-hosted": {
        id: "file-hosted",
        mimeType: "image/png",
        dataURL: `/api/files/${drawingId}/file-hosted`,
      },
    };

    const result = await processEmbeddedImages(deps(), files, ownerId, drawingId);

    expect(result["file-b64"].dataURL).toBe(`/api/files/${drawingId}/file-b64`);
    expect(result["file-hosted"].dataURL).toBe(`/api/files/${drawingId}/file-hosted`);
    expect(await prisma.drawingFile.count({ where: { drawingId } })).toBe(1);
  });
});
