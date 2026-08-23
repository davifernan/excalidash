/**
 * The document bookkeeping, against a real SQLite database.
 *
 * A fake would only mirror the implementation. These run the actual queries,
 * which is the only way to find out whether the relations, the uniqueness
 * constraint and the cascade behave as the design assumes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { PrismaClient } from "../generated/client";
import { getTestPrisma, setupTestDb, cleanupTestDb, createTestUser } from "../__tests__/testUtils";
import { storedSize, originalKey, resolveStoragePath } from "./assetStorage";
import {
  QuotaExceededError,
  captureSnapshotAssets,
  collectExpired,
  createAsset,
  syncDrawingAssets,
  sweepUnclaimed,
  usedBytesFor,
} from "./assetService";
import { referencedAssetIds } from "./documentWidgetState";

describe("document bookkeeping", () => {
  let prisma: PrismaClient;
  let storageDir: string;
  let userId: string;
  let otherUserId: string;
  let drawingId: string;

  const deps = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      prisma,
      storageDir,
      maxUploadBytes: 1024 * 1024,
      maxPerUserBytes: 4 * 1024 * 1024,
      ...over,
    }) as any;

  const upload = (text: string, over: Record<string, unknown> = {}) =>
    createAsset(deps(over.deps as object), {
      ownerUserId: userId,
      uploadedByUserId: userId,
      drawingId,
      kind: "PDF",
      originalName: "bericht.pdf",
      mimeType: "application/pdf",
      source: Readable.from([Buffer.from(text)]),
      ...over,
    } as any);

  const widget = (id: string, assetId: unknown, over: Record<string, unknown> = {}) => ({
    id,
    type: "embeddable",
    link: "excalidash://asset-widget",
    customData: { excalidash: { schemaVersion: 2, widget: { kind: "pdf", assetId } } },
    ...over,
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
    await prisma.drawingSnapshotAsset.deleteMany({});
    await prisma.drawingAsset.deleteMany({});
    await prisma.asset.deleteMany({});
    await prisma.storedBlob.deleteMany({});
    await prisma.drawingSnapshot.deleteMany({});
    await prisma.drawing.deleteMany({});
    await prisma.user.deleteMany({});

    storageDir = await mkdtemp(join(tmpdir(), "assetsvc-"));
    const owner = await createTestUser(prisma, "owner@example.com");
    const other = await createTestUser(prisma, "other@example.com");
    userId = owner.id;
    otherUserId = other.id;
    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", userId },
    });
    drawingId = drawing.id;
  });

  it("stores the bytes and attaches the document to the board as pending", async () => {
    const { asset, sizeBytes } = await upload("hello world");

    expect(sizeBytes).toBe(11);
    const link = await prisma.drawingAsset.findFirst({ where: { drawingId, assetId: asset.id } });
    expect(link?.state).toBe("PENDING");
    expect(link?.expiresAt).toBeInstanceOf(Date);
  });

  it("keeps one copy on disk when the same file is uploaded twice", async () => {
    const first = await upload("identical bytes");
    const second = await upload("identical bytes");

    expect(second.blob.id).toBe(first.blob.id);
    expect(second.asset.id).not.toBe(first.asset.id);
    expect(await prisma.storedBlob.count()).toBe(1);
    expect(await prisma.asset.count()).toBe(2);
  });

  it("deduplicates by prepared bytes when that blob already exists", async () => {
    const optimized = "optimized pdf bytes";
    const existing = await upload(optimized);
    const prepared = await upload("large original pdf bytes that will be rebuilt", {
      prepareStored: async ({ path }: { path: string }) => {
        await writeFile(path, optimized);
        return { note: "rebuilt" };
      },
    });

    expect(prepared.blob.id).toBe(existing.blob.id);
    expect(prepared.note).toBe("rebuilt");
    expect(prepared.sizeBytes).toBe(Buffer.byteLength(optimized));
    expect(await prisma.storedBlob.count()).toBe(1);
  });

  it("prepares a provisional copy without changing a shared original blob", async () => {
    const original = "same original bytes uploaded twice";
    const optimized = "smaller bytes";
    const first = await upload(original);
    const second = await upload(original, {
      prepareStored: async ({ path }: { path: string }) => {
        await writeFile(path, optimized);
        return { note: null };
      },
    });

    expect(second.blob.id).not.toBe(first.blob.id);
    expect(await prisma.storedBlob.count()).toBe(2);
    expect(await readFile(resolveStoragePath(storageDir, first.blob.storageKey), "utf8")).toBe(
      original,
    );
    expect(await readFile(resolveStoragePath(storageDir, second.blob.storageKey), "utf8")).toBe(
      optimized,
    );
  });

  it("gives each upload its own name and owner even when the bytes are shared", async () => {
    await upload("shared bytes", { originalName: "meins.pdf" });
    await upload("shared bytes", { ownerUserId: otherUserId, originalName: "deins.pdf" });

    const names = (
      await prisma.asset.findMany({ select: { originalName: true, ownerUserId: true } })
    ).sort((a, b) => a.originalName.localeCompare(b.originalName));
    expect(names.map((n) => n.originalName)).toEqual(["deins.pdf", "meins.pdf"]);
    expect(names[0].ownerUserId).not.toBe(names[1].ownerUserId);
  });

  it("charges an owner once for a file they used twice", async () => {
    await upload("twelve bytes");
    await upload("twelve bytes");
    expect(await usedBytesFor(prisma, userId)).toBe(12);
  });

  it("refuses an upload once the owner is out of room", async () => {
    await upload("x".repeat(100), { deps: { maxPerUserBytes: 100 } });
    await expect(
      upload("y".repeat(100), { deps: { maxPerUserBytes: 100 } }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("does not let an upload overshoot the remaining room", async () => {
    await upload("x".repeat(80), { deps: { maxPerUserBytes: 100 } });
    // Only 20 bytes left, so a 50-byte file has to be refused mid-stream.
    await expect(upload("y".repeat(50), { deps: { maxPerUserBytes: 100 } })).rejects.toThrow();
    expect(await usedBytesFor(prisma, userId)).toBe(80);
  });

  it("admits concurrent uploads against one serialized owner quota", async () => {
    const results = await Promise.allSettled([
      upload("a".repeat(60), { deps: { maxPerUserBytes: 100 } }),
      upload("b".repeat(60), { deps: { maxPerUserBytes: 100 } }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await usedBytesFor(prisma, userId)).toBeLessThanOrEqual(100);
  });

  describe("reconciling a board with what it draws", () => {
    it("turns a referenced document active", async () => {
      const { asset } = await upload("doc");
      const result = await syncDrawingAssets(prisma, drawingId, [asset.id]);

      expect(result.activated).toEqual([asset.id]);
      const link = await prisma.drawingAsset.findFirst({ where: { assetId: asset.id } });
      expect(link?.state).toBe("ACTIVE");
      expect(link?.expiresAt).toBeNull();
    });

    it("detaches a document whose widget was removed", async () => {
      const { asset } = await upload("doc");
      await syncDrawingAssets(prisma, drawingId, [asset.id]);
      const result = await syncDrawingAssets(prisma, drawingId, []);

      expect(result.detached).toEqual([asset.id]);
      expect(await prisma.drawingAsset.count({ where: { drawingId } })).toBe(0);
    });

    it("refuses an id this board never had", async () => {
      await expect(syncDrawingAssets(prisma, drawingId, ["not-mine"])).rejects.toThrow(
        /does not have a document/,
      );
    });

    it("refuses a document belonging to another board", async () => {
      const otherBoard = await prisma.drawing.create({
        data: { name: "Other", elements: "[]", appState: "{}", userId },
      });
      const { asset } = await upload("doc", { drawingId: otherBoard.id });

      await expect(syncDrawingAssets(prisma, drawingId, [asset.id])).rejects.toThrow(
        /does not have a document/,
      );
    });
  });

  describe("reading document ids out of a board", () => {
    it("finds the ids the widgets name", () => {
      expect(referencedAssetIds([widget("a", "doc-1"), widget("b", "doc-2")])).toEqual([
        "doc-1",
        "doc-2",
      ]);
    });

    it("ignores elements that name nothing", () => {
      expect(
        referencedAssetIds([{ id: "a" }, { id: "b", customData: {} }, widget("c", 42)]),
      ).toEqual([]);
    });

    it("ignores a deleted widget, so removing one detaches its document", () => {
      expect(referencedAssetIds([widget("a", "doc-1", { isDeleted: true })])).toEqual([]);
    });

    it("names each document once even when several widgets show it", () => {
      expect(referencedAssetIds([widget("a", "doc-1"), widget("b", "doc-1")])).toEqual(["doc-1"]);
    });

    it("refuses an id long enough to be an attack rather than a mistake", () => {
      expect(referencedAssetIds([widget("a", "x".repeat(500))])).toEqual([]);
    });

    it("survives anything that is not a list of elements", () => {
      expect(referencedAssetIds(null)).toEqual([]);
      expect(referencedAssetIds("elements")).toEqual([]);
      expect(referencedAssetIds([null, undefined, 7])).toEqual([]);
    });
  });

  describe("sweeping", () => {
    it("removes an upload no save ever referred to", async () => {
      const { asset } = await upload("abandoned");
      const later = Date.now() + 25 * 60 * 60 * 1000;

      const result = await sweepUnclaimed(deps({ now: () => later }));
      expect(result.pending).toBe(1);
      expect(await prisma.drawingAsset.count()).toBe(0);
      // Marked for removal, not removed yet.
      const marked = await prisma.asset.findUnique({ where: { id: asset.id } });
      expect(marked?.deleteAfter).toBeInstanceOf(Date);
    });

    it("leaves an upload alone while its grace period runs", async () => {
      await upload("fresh");
      const result = await sweepUnclaimed(deps());
      expect(result.pending).toBe(0);
      expect(await prisma.drawingAsset.count()).toBe(1);
    });

    it("keeps a document a snapshot still needs", async () => {
      const { asset } = await upload("historic");
      await syncDrawingAssets(prisma, drawingId, [asset.id]);
      const snapshot = await prisma.drawingSnapshot.create({
        data: { drawingId, version: 1, elements: "[]", appState: "{}" },
      });
      await captureSnapshotAssets(prisma, snapshot.id, drawingId);

      // The widget is removed from the current board.
      await syncDrawingAssets(prisma, drawingId, []);
      await sweepUnclaimed(deps({ now: () => Date.now() + 25 * 60 * 60 * 1000 }));

      const survivor = await prisma.asset.findUnique({ where: { id: asset.id } });
      expect(survivor?.deleteAfter).toBeNull();
    });

    it("removes the bytes once the last document holding them is gone", async () => {
      const { asset, blob } = await upload("disposable");
      const key = originalKey(blob.id);
      expect(await storedSize(storageDir, key)).toBe("disposable".length);

      const later = Date.now() + 25 * 60 * 60 * 1000;
      await sweepUnclaimed(deps({ now: () => later }));
      const result = await collectExpired(deps({ now: () => later + 25 * 60 * 60 * 1000 }));

      expect(result.assets).toBe(1);
      expect(result.blobs).toBe(1);
      expect(await storedSize(storageDir, key)).toBeNull();
      expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toBeNull();
    });

    it("keeps the bytes while another document still shares them", async () => {
      const first = await upload("shared bytes");
      const second = await upload("shared bytes");
      await syncDrawingAssets(prisma, drawingId, [second.asset.id]);

      const later = Date.now() + 25 * 60 * 60 * 1000;
      await sweepUnclaimed(deps({ now: () => later }));
      const result = await collectExpired(deps({ now: () => later + 25 * 60 * 60 * 1000 }));

      expect(result.assets).toBe(1);
      expect(result.blobs).toBe(0);
      expect(await storedSize(storageDir, originalKey(first.blob.id))).toBe(12);
    });

    it("revives bytes that were on their way out when they are uploaded again", async () => {
      const first = await upload("recycled");
      const later = Date.now() + 25 * 60 * 60 * 1000;
      await sweepUnclaimed(deps({ now: () => later }));

      const again = await upload("recycled");
      expect(again.blob.id).toBe(first.blob.id);
      const blob = await prisma.storedBlob.findUnique({ where: { id: first.blob.id } });
      expect(blob?.deleteAfter).toBeNull();
    });
  });
});
