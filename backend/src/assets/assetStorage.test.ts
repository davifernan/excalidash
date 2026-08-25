import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  AssetTooLargeError,
  originalKey,
  pageCacheKey,
  removeStored,
  resolveStoragePath,
  shouldCompress,
  storeStream,
  storedSize,
} from "./assetStorage";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assets-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const streamOf = (...chunks: string[]) => Readable.from(chunks.map((c) => Buffer.from(c)));

describe("storage keys", () => {
  it("spreads originals over two directory levels", () => {
    expect(originalKey("abcdef12-3456")).toBe("originals/ab/cd/abcdef12-3456");
  });

  it("refuses an id too short to spread", () => {
    expect(() => originalKey("ab")).toThrow(/too short/);
  });

  it("strips anything that could climb out of the directory", () => {
    expect(originalKey("../../etc/passwd")).toBe("originals/et/cp/etcpasswd");
  });

  it("puts the renderer version into the cache path", () => {
    expect(pageCacheKey("doc1", "poppler-24.02", 7, ".svg.br")).toBe(
      "cache/doc1/poppler-24.02/000007.svg.br",
    );
  });

  it("pads page numbers so they sort as they read", () => {
    expect(pageCacheKey("doc1", "v1", 1, ".svg")).toContain("000001");
    expect(pageCacheKey("doc1", "v1", 200, ".svg")).toContain("000200");
  });

  it("refuses a page that is not a positive whole number", () => {
    expect(() => pageCacheKey("doc1", "v1", 0, ".svg")).toThrow(/positive integer/);
    expect(() => pageCacheKey("doc1", "v1", -3, ".svg")).toThrow(/positive integer/);
    expect(() => pageCacheKey("doc1", "v1", 1.5, ".svg")).toThrow(/positive integer/);
  });
});

describe("resolving a key to a path", () => {
  it("keeps a normal key inside the directory", () => {
    expect(resolveStoragePath("/var/assets", "originals/ab/cd/x")).toBe(
      "/var/assets/originals/ab/cd/x",
    );
  });

  it("refuses a key that climbs out", () => {
    expect(() => resolveStoragePath("/var/assets", "../secrets")).toThrow(
      /outside the asset directory/,
    );
  });

  it("refuses an absolute key pointing elsewhere", () => {
    expect(() => resolveStoragePath("/var/assets", "/etc/passwd")).toThrow(
      /outside the asset directory/,
    );
  });

  it("refuses a sibling directory with the same prefix", () => {
    expect(() => resolveStoragePath("/var/assets", "../assets-other/x")).toThrow(
      /outside the asset directory/,
    );
  });
});

describe("storing an upload", () => {
  it("writes the file and reports its size and hash", async () => {
    const stored = await storeStream(
      root,
      originalKey("aabbccdd"),
      streamOf("hello ", "world"),
      1024,
    );

    expect(stored.sizeBytes).toBe(11);
    // sha256 of "hello world"
    expect(stored.sha256).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(await readFile(join(root, stored.storageKey), "utf8")).toBe("hello world");
  });

  it("refuses a file over the limit", async () => {
    await expect(
      storeStream(root, originalKey("aabbccdd"), streamOf("x".repeat(500)), 100),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
  });

  it("counts bytes as they arrive rather than trusting a declared size", async () => {
    // Arrives in small pieces that only exceed the limit together.
    const chunks = Array.from({ length: 20 }, () => "y".repeat(10));
    await expect(
      storeStream(root, originalKey("aabbccdd"), streamOf(...chunks), 150),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
  });

  it("leaves nothing behind when it refuses a file", async () => {
    await storeStream(root, originalKey("aabbccdd"), streamOf("x".repeat(500)), 100).catch(
      () => {},
    );
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("leaves nothing behind when the upload breaks off mid-way", async () => {
    let stagingWasOpenBeforeRead = false;
    const broken = new Readable({
      read() {
        stagingWasOpenBeforeRead = readdirSync(join(root, "staging")).some((name) =>
          name.endsWith(".part"),
        );
        this.push(Buffer.from("partial"));
        this.destroy(new Error("connection lost"));
      },
    });
    await expect(storeStream(root, originalKey("aabbccdd"), broken, 1024)).rejects.toThrow(
      /connection lost/,
    );
    expect(stagingWasOpenBeforeRead).toBe(true);
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("never publishes a half-written file", async () => {
    const key = originalKey("aabbccdd");
    const broken = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("connection lost"));
      },
    });
    await storeStream(root, key, broken, 1024).catch(() => {});
    expect(await storedSize(root, key)).toBeNull();
  });
});

describe("reading and removing", () => {
  it("reports the size of a stored file", async () => {
    const key = originalKey("aabbccdd");
    await storeStream(root, key, streamOf("12345"), 1024);
    expect(await storedSize(root, key)).toBe(5);
  });

  it("reports null for a file that is not there", async () => {
    expect(await storedSize(root, originalKey("ffffffff"))).toBeNull();
  });

  it("does not mistake a directory for a file", async () => {
    expect(await storedSize(root, "originals")).toBeNull();
  });

  it("removes a file", async () => {
    const key = originalKey("aabbccdd");
    await storeStream(root, key, streamOf("12345"), 1024);
    await removeStored(root, key);
    expect(await storedSize(root, key)).toBeNull();
  });

  it("treats removing something already gone as done", async () => {
    await expect(removeStored(root, originalKey("ffffffff"))).resolves.toBeUndefined();
  });

  it("refuses to remove outside the directory", async () => {
    const bystander = join(root, "..", "bystander.txt");
    await writeFile(bystander, "keep me");
    await expect(removeStored(root, "../bystander.txt")).rejects.toThrow(
      /outside the asset directory/,
    );
    expect(await readFile(bystander, "utf8")).toBe("keep me");
    await rm(bystander, { force: true });
  });
});

describe("storing compressed", () => {
  it("leaves a PDF alone, because PDFs compress their own contents already", () => {
    expect(shouldCompress("application/pdf")).toBe(false);
    expect(shouldCompress("image/png")).toBe(false);
    expect(shouldCompress("image/jpeg")).toBe(false);
  });

  it("compresses text and the page previews", () => {
    expect(shouldCompress("text/plain")).toBe(true);
    expect(shouldCompress("text/markdown; charset=utf-8")).toBe(true);
    expect(shouldCompress("image/svg+xml")).toBe(true);
  });

  it("writes fewer bytes than it received", async () => {
    const text = "the same sentence over and over. ".repeat(200);
    const stored = await storeStream(root, originalKey("aabbccdd"), streamOf(text), 1_000_000, {
      compress: true,
    });

    expect(stored.sizeBytes).toBe(text.length);
    expect(stored.storedBytes).toBeLessThan(text.length / 4);
    expect(stored.contentEncoding).toBe("br");
    expect(await storedSize(root, stored.storageKey)).toBe(stored.storedBytes);
  });

  it("hashes the original, so the same file deduplicates either way", async () => {
    const text = "identical content";
    const plain = await storeStream(root, originalKey("11112222"), streamOf(text), 1024);
    const packed = await storeStream(root, originalKey("33334444"), streamOf(text), 1024, {
      compress: true,
    });

    expect(packed.sha256).toBe(plain.sha256);
    expect(packed.storedBytes).not.toBe(plain.storedBytes);
  });

  it("measures the limit against the original, not the compressed size", async () => {
    // Compresses to almost nothing, but the caller asked for a 100 byte cap.
    await expect(
      storeStream(root, originalKey("aabbccdd"), streamOf("a".repeat(5000)), 100, {
        compress: true,
      }),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
  });

  it("reports the uncompressed size, which is what a reader receives", async () => {
    const stored = await storeStream(
      root,
      originalKey("aabbccdd"),
      streamOf("x".repeat(900)),
      10_000,
      {
        compress: true,
      },
    );
    expect(stored.sizeBytes).toBe(900);
  });
});
