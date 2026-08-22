import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStoragePath } from "../assets/assetStorage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectExpiredLinkPreviews,
  evictLinkPreviewCache,
  previewDiskBytes,
  PREVIEW_BLOB_GRACE_MS,
} from "./cache";
import { createLinkPreviewService } from "./service";
import { fakePreviewPrisma, previewTestConfig as config } from "./testSupport";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const seedRows = (prisma: ReturnType<typeof fakePreviewPrisma>, prefix: string) => {
  const base = Date.now() - 60_000;
  for (let index = 1; index <= 3; index += 1) {
    const blobId = `${prefix}-blob-${index}`;
    prisma.blobs.set(blobId, {
      id: blobId,
      storageKey: `originals/${blobId}`,
      storedBytes: 60,
      state: "READY",
      purpose: "LINK_PREVIEW",
      createdAt: new Date(base + index),
      deleteAfter: null,
    });
    prisma.rows.set(`${prefix}-key-${index}`, {
      id: `${prefix}-row-${index}`,
      cacheKey: `${prefix}-key-${index}`,
      ownerUserId: "user-1",
      imageBlobId: blobId,
      faviconBlobId: null,
      lastAccessedAt: new Date(base + index),
      expiresAt: new Date(base + 120_000),
    });
  }
};

describe("bounded link preview cache", () => {
  it("evicts one user's least recently used entries at the hard entry limit", async () => {
    const prisma = fakePreviewPrisma();
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config: { ...config, maxEntriesPerUser: 2 },
      fetchResource: vi.fn(async (url: URL) => ({
        body: Buffer.from(`<head><title>${url.pathname}</title></head>`),
        finalUrl: url,
        contentType: "text/html",
        headers: {},
      })),
    });

    await getPreview("user-1", "https://example.com/oldest");
    await getPreview("user-1", "https://example.com/middle");
    await getPreview("user-1", "https://example.com/newest");

    expect([...prisma.rows.values()].map((row) => row.requestedUrl).sort()).toEqual([
      "https://example.com/middle",
      "https://example.com/newest",
    ]);
  });

  it("evicts global preview art by LRU until the byte budget has headroom", async () => {
    const prisma = fakePreviewPrisma();
    seedRows(prisma, "global");

    await evictLinkPreviewCache({
      prisma,
      storageDir: "/unused",
      config: { ...config, cacheBudgetBytes: 100 },
    });

    expect([...prisma.rows.values()].map((row) => row.id)).toEqual(["global-row-3"]);
    expect(prisma.blobs.get("global-blob-1").deleteAfter).toBeInstanceOf(Date);
    expect(prisma.blobs.get("global-blob-2").deleteAfter).toBeInstanceOf(Date);
  });

  it("evicts one user's LRU rows when that user's byte budget is exceeded", async () => {
    const prisma = fakePreviewPrisma();
    seedRows(prisma, "user");

    await evictLinkPreviewCache(
      {
        prisma,
        storageDir: "/unused",
        config: { ...config, maxBytesPerUser: 100 },
      },
      "user-1",
    );

    expect([...prisma.rows.values()].map((row) => row.id)).toEqual(["user-row-3"]);
  });

  it("releases blobs referenced by a cache row overwritten by another instance", async () => {
    const prisma = fakePreviewPrisma();
    prisma.blobs.set("old-blob", {
      id: "old-blob",
      storageKey: "originals/old-blob",
      storedBytes: 50,
      state: "READY",
      purpose: "LINK_PREVIEW",
      createdAt: new Date(),
      deleteAfter: null,
    });
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config,
      fetchResource: vi.fn(async (url: URL, kind: string) => {
        if (kind === "html") {
          const cacheKey = createHash("sha256").update("user-1\0").update(url.href).digest("hex");
          prisma.rows.set(cacheKey, {
            id: "racing-row",
            cacheKey,
            requestedUrl: url.href,
            status: "READY",
            imageBlobId: "old-blob",
            faviconBlobId: null,
            ownerUserId: "user-1",
            lastAccessedAt: new Date(0),
            expiresAt: new Date(Date.now() + 60_000),
          });
        }
        return {
          body: Buffer.from("<head><title>Replacement</title></head>"),
          finalUrl: url,
          contentType: "text/html",
          headers: {},
        };
      }),
    });

    await getPreview("user-1", "https://example.com/race");
    expect(prisma.storedBlob.updateMany).toHaveBeenCalled();
    expect(prisma.blobs.get("old-blob").deleteAfter).toBeInstanceOf(Date);
  });

  it("cleans expired rows and abandoned blobs in bounded batches", async () => {
    const prisma = fakePreviewPrisma();
    const storageDir = await mkdtemp(join(tmpdir(), "link-preview-cleanup-"));
    tempDirs.push(storageDir);
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      prisma.rows.set(`expired-${index}`, {
        id: `expired-${index}`,
        cacheKey: `expired-${index}`,
        imageBlobId: null,
        faviconBlobId: null,
        expiresAt: new Date(now - 1),
        lastAccessedAt: new Date(now - 1),
      });
      prisma.blobs.set(`orphan-${index}`, {
        id: `orphan-${index}`,
        storageKey: `originals/orphan-${index}`,
        storedBytes: 10,
        state: "READY",
        purpose: "LINK_PREVIEW",
        createdAt: new Date(now - PREVIEW_BLOB_GRACE_MS - index - 1),
        deleteAfter: null,
      });
    }

    const result = await collectExpiredLinkPreviews({
      prisma,
      storageDir,
      config: { ...config, cleanupBatchSize: 2 },
      now: () => now,
    });

    expect(result).toEqual({ previews: 5, blobs: 5 });
    expect(prisma.rows.size).toBe(0);
    expect(prisma.blobs.size).toBe(0);
    expect(prisma.linkPreview.findMany.mock.calls.every(([args]: any[]) => args.take <= 2)).toBe(
      true,
    );
    expect(prisma.storedBlob.findMany.mock.calls.every(([args]: any[]) => args.take <= 2)).toBe(
      true,
    );
  });

  it("counts orphaned preview blobs against the byte ceiling before storing more art", async () => {
    const prisma = fakePreviewPrisma();
    prisma.blobs.set("orphan-budget", {
      id: "orphan-budget",
      storageKey: "originals/orphan-budget",
      storedBytes: 100,
      purpose: "LINK_PREVIEW",
      state: "READY",
      createdAt: new Date(),
      deleteAfter: new Date(Date.now() + PREVIEW_BLOB_GRACE_MS),
    });
    const fetchResource = vi.fn(async (url: URL, kind: string) => ({
      body:
        kind === "html"
          ? Buffer.from(
              '<head><title>Text survives</title><meta property="og:image" content="/art.png"></head>',
            )
          : Buffer.from("image input"),
      finalUrl: url,
      contentType: kind === "html" ? "text/html" : "image/png",
      headers: {},
    }));
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config: { ...config, cacheBudgetBytes: 100 },
      fetchResource,
      sanitizeImage: vi.fn(async () => Buffer.alloc(10)),
    });

    const result = await getPreview("user-1", "https://example.com/budget");
    expect(result.title).toBe("Text survives");
    expect(result.imageBlobId).toBeNull();
    expect(prisma.blobs.size).toBe(1);
  });

  it("refuses new preview art when the filesystem reserve would be crossed", async () => {
    const prisma = fakePreviewPrisma();
    const storageDir = await mkdtemp(join(tmpdir(), "link-preview-reserve-"));
    tempDirs.push(storageDir);
    const fetchResource = vi.fn(async (url: URL, kind: string) => ({
      body:
        kind === "html"
          ? Buffer.from(
              '<head><title>Text survives</title><meta property="og:image" content="/art.png"></head>',
            )
          : Buffer.from("image input"),
      finalUrl: url,
      contentType: kind === "html" ? "text/html" : "image/png",
      headers: {},
    }));
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir,
      config: { ...config, minFreeDiskPercent: 100 },
      fetchResource,
      sanitizeImage: vi.fn(async () => Buffer.alloc(10)),
    });

    const result = await getPreview("user-1", "https://example.com/reserve");
    expect(result.title).toBe("Text survives");
    expect(result.imageBlobId).toBeNull();
    expect(prisma.blobs.size).toBe(0);
  });
});

describe("eviction and what is actually on disk", () => {
  const withStorage = async () => {
    const dir = await mkdtemp(join(tmpdir(), "linkcache-"));
    tempDirs.push(dir);
    return dir;
  };

  /** A preview blob with a real file behind it, old enough to be past the grace window. */
  const seedOldBlob = async (
    prisma: ReturnType<typeof fakePreviewPrisma>,
    storageDir: string,
    id: string,
    bytes: number,
  ) => {
    const storageKey = `originals/${id}`;
    const path = resolveStoragePath(storageDir, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes));
    const old = new Date(Date.now() - PREVIEW_BLOB_GRACE_MS - 60_000);
    prisma.blobs.set(id, {
      id,
      storageKey,
      storedBytes: bytes,
      state: "READY",
      purpose: "LINK_PREVIEW",
      createdAt: old,
      deleteAfter: null,
    });
    prisma.rows.set(`key-${id}`, {
      id: `row-${id}`,
      cacheKey: `key-${id}`,
      ownerUserId: "user-1",
      imageBlobId: id,
      faviconBlobId: null,
      lastAccessedAt: old,
      expiresAt: new Date(Date.now() + 120_000),
    });
    return path;
  };

  it("frees the bytes it evicts instead of only dropping the rows", async () => {
    const storageDir = await withStorage();
    const prisma = fakePreviewPrisma();
    const perBlob = Math.ceil(config.cacheBudgetBytes / 2);
    const first = await seedOldBlob(prisma, storageDir, "old-1", perBlob);
    const second = await seedOldBlob(prisma, storageDir, "old-2", perBlob);

    await evictLinkPreviewCache({ prisma, storageDir, config }, undefined, true);

    // Dropping the rows is not the point. What decides whether the next preview
    // may be stored is what is on disk, so the files have to be gone as well.
    await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(second)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await previewDiskBytes(prisma)).toBe(0);
  });

  it("leaves a blob that is too young to be safely deleted", async () => {
    const storageDir = await withStorage();
    const prisma = fakePreviewPrisma();
    const path = await seedOldBlob(prisma, storageDir, "young-1", 100);
    // Just stored: another instance could be about to link it.
    prisma.blobs.get("young-1")!.createdAt = new Date();

    await evictLinkPreviewCache({ prisma, storageDir, config }, undefined, true);

    await expect(stat(path)).resolves.toBeTruthy();
    expect(prisma.blobs.get("young-1")!.deleteAfter).toBeInstanceOf(Date);
  });
});

describe("what the sweep and the per-user limits actually cover", () => {
  it("removes the file behind an abandoned blob, not only its row", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "link-preview-sweep-"));
    tempDirs.push(storageDir);
    const prisma = fakePreviewPrisma();
    const now = Date.now();
    const storageKey = "originals/abandoned";
    const path = resolveStoragePath(storageDir, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(64));
    prisma.blobs.set("abandoned", {
      id: "abandoned",
      storageKey,
      storedBytes: 64,
      state: "READY",
      purpose: "LINK_PREVIEW",
      createdAt: new Date(now - PREVIEW_BLOB_GRACE_MS - 1),
      deleteAfter: null,
    });

    await collectExpiredLinkPreviews({ prisma, storageDir, config, now: () => now });

    // The sweep's own test seeds rows without files, and removing a file that
    // was never there looks exactly like removing one that was.
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let one person's previews evict another's", async () => {
    const prisma = fakePreviewPrisma();
    const now = Date.now();
    const seed = (owner: string, index: number) => {
      prisma.rows.set(`${owner}-key-${index}`, {
        id: `${owner}-row-${index}`,
        cacheKey: `${owner}-key-${index}`,
        ownerUserId: owner,
        imageBlobId: null,
        faviconBlobId: null,
        lastAccessedAt: new Date(now - 1000 + index),
        expiresAt: new Date(now + 120_000),
      });
    };
    // One person well past the entry limit, another comfortably inside it.
    for (let i = 0; i < config.maxEntriesPerUser + 3; i += 1) seed("noisy", i);
    for (let i = 0; i < 2; i += 1) seed("quiet", i);

    await evictLinkPreviewCache({ prisma, storageDir: "/unused", config }, "noisy");

    const owners = [...prisma.rows.values()].map((row: any) => row.ownerUserId);
    expect(owners.filter((owner) => owner === "quiet")).toHaveLength(2);
    expect(owners.filter((owner) => owner === "noisy")).toHaveLength(config.maxEntriesPerUser);
  });
});

describe("deleting a blob somebody else is adopting", () => {
  it("leaves a blob another instance has already claimed", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "link-preview-claim-"));
    tempDirs.push(storageDir);
    const prisma = fakePreviewPrisma();
    const now = Date.now();
    const storageKey = "originals/claimed";
    const path = resolveStoragePath(storageDir, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(32));
    prisma.blobs.set("claimed", {
      id: "claimed",
      storageKey,
      storedBytes: 32,
      // Another instance is already deleting this one.
      state: "DELETING",
      purpose: "LINK_PREVIEW",
      createdAt: new Date(now - PREVIEW_BLOB_GRACE_MS - 1),
      deleteAfter: null,
    });

    const result = await collectExpiredLinkPreviews({ prisma, storageDir, config, now: () => now });

    expect(result.blobs).toBe(0);
    expect(prisma.blobs.get("claimed")).toBeTruthy();
  });
});
