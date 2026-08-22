import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { PrismaClient } from "../generated/client";
import { cleanupTestDb, createTestUser, getTestPrisma, setupTestDb } from "../__tests__/testUtils";
import { createDocumentPageManager } from "../server/socketDocumentPages";
import { createAsset } from "./assetService";
import { resolveStoragePath } from "./assetStorage";
import { deriveAssetPageCount } from "./documentPageCount";
import {
  DOCUMENT_WIDGET_LIMIT,
  InvalidDocumentWidgetStateError,
  syncDrawingDocumentState,
} from "./documentWidgetState";

describe("authoritative document widget state", () => {
  let prisma: PrismaClient;
  let storageDir: string;
  let userId: string;
  let drawingId: string;

  const upload = (text: string, over: Record<string, unknown> = {}) =>
    createAsset(
      {
        prisma,
        storageDir,
        maxUploadBytes: 1024 * 1024,
        maxPerUserBytes: 4 * 1024 * 1024,
      },
      {
        ownerUserId: userId,
        uploadedByUserId: userId,
        drawingId,
        kind: "PDF",
        originalName: "bericht.pdf",
        mimeType: "application/pdf",
        source: Readable.from([Buffer.from(text)]),
        ...over,
      } as any,
    );

  const widget = (id: string, assetId: unknown) => ({
    id,
    type: "embeddable",
    link: "excalidash://asset-widget",
    customData: { schemaVersion: 1, widgetKind: "pdf", assetId },
  });

  beforeAll(() => {
    setupTestDb();
    prisma = getTestPrisma();
  });

  afterAll(async () => {
    await cleanupTestDb(prisma);
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.drawingAsset.deleteMany({});
    await prisma.asset.deleteMany({});
    await prisma.storedBlob.deleteMany({});
    await prisma.drawing.deleteMany({});
    await prisma.user.deleteMany({});
    storageDir = await mkdtemp(join(tmpdir(), "document-state-"));
    userId = (await createTestUser(prisma, "owner@example.com")).id;
    drawingId = (
      await prisma.drawing.create({
        data: { name: "Board", elements: "[]", appState: "{}", userId },
      })
    ).id;
  });

  it("derives a legacy text page count once and reuses the persisted value", async () => {
    const text = "line\n".repeat(5_000);
    const { asset, blob } = await upload(text, {
      kind: "TEXT",
      mimeType: "text/plain; charset=utf-8",
      originalName: "notes.txt",
    });

    await expect(deriveAssetPageCount(prisma, storageDir, asset.id)).resolves.toBe(2);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))?.pageCount).toBe(2);

    // Removing the source bytes turns a second derivation attempt into ENOENT.
    // Success therefore proves that the second access uses the materialized
    // database value and never enters the byte-reading/pagination path again.
    await rm(resolveStoragePath(storageDir, blob.storageKey));
    await expect(deriveAssetPageCount(prisma, storageDir, asset.id)).resolves.toBe(2);
  });

  it("materializes and removes the authoritative widget binding", async () => {
    const { asset } = await upload("doc");
    await syncDrawingDocumentState(prisma, drawingId, [widget("widget-1", asset.id)]);

    expect(
      await prisma.documentPageView.findUnique({
        where: { drawingId_elementId: { drawingId, elementId: "widget-1" } },
      }),
    ).toMatchObject({ assetId: asset.id, page: 1, revision: 0 });

    await syncDrawingDocumentState(prisma, drawingId, []);
    expect(await prisma.documentPageView.count({ where: { drawingId } })).toBe(0);
  });

  it("serializes concurrent page turns with real database revisions", async () => {
    const { asset } = await upload("doc");
    await prisma.asset.update({ where: { id: asset.id }, data: { pageCount: 5 } });
    await syncDrawingDocumentState(prisma, drawingId, [widget("widget-1", asset.id)]);
    const broadcasts: any[] = [];
    const pages = createDocumentPageManager({
      prisma,
      io: {
        to: () => ({ emit: (_event: string, value: unknown) => broadcasts.push(value) }),
      } as any,
    });

    await Promise.all([
      pages.set({ drawingId, elementId: "widget-1", page: 2 }),
      pages.set({ drawingId, elementId: "widget-1", page: 3 }),
    ]);

    const saved = await prisma.documentPageView.findUnique({
      where: { drawingId_elementId: { drawingId, elementId: "widget-1" } },
    });
    const updates = broadcasts.map((broadcast) => broadcast.pages[0]);
    expect(updates.map((update) => update.revision).sort()).toEqual([1, 2]);
    expect(updates.find((update) => update.revision === 2)?.page).toBe(saved?.page);
    expect(saved?.revision).toBe(2);
  });

  it("rejects a scene above the real-widget limit before creating rows", async () => {
    const { asset } = await upload("doc");
    const widgets = Array.from({ length: DOCUMENT_WIDGET_LIMIT + 1 }, (_, index) =>
      widget(`widget-${index}`, asset.id),
    );

    await expect(syncDrawingDocumentState(prisma, drawingId, widgets)).rejects.toBeInstanceOf(
      InvalidDocumentWidgetStateError,
    );
    expect(await prisma.documentPageView.count({ where: { drawingId } })).toBe(0);
  });
});
