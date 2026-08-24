import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { pageCacheKey, resolveStoragePath, storeStream } from "./assetStorage";
import { RENDERER_VERSION } from "./pdfRenderer";
import {
  DiskFullError,
  QueueAbortedError,
  QueueCapacityError,
  renderQueueDepth,
  evictToBudget,
  getPage,
  listCached,
} from "./pageCache";
import { Readable } from "node:stream";

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "pagecache-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(storageDir, { recursive: true, force: true });
});

const asset = { id: "doc-1", blob: { storageKey: "originals/do/c1/doc-1" } };

const deps = (over: Record<string, unknown> = {}) =>
  ({
    storageDir,
    cacheBudgetBytes: 10_000,
    minFreeDiskPercent: 0,
    ...over,
  }) as any;

const svgRender = vi.fn(async (_path: string, page: number) => ({
  body: Buffer.from(`<svg>page ${page} ${"filler ".repeat(50)}</svg>`),
  mimeType: "image/svg+xml" as const,
}));

/**
 * Wait until the render queue actually holds what the test is about to rely on.
 *
 * Calling getPage does not put anything in the queue: it reads the cache first,
 * and only a miss reaches the queue, an await later. Acting on the next line
 * assumes the scheduler got there first, which it usually does -- until
 * something else in the run allocates enough to make it not. That is exactly
 * how these tests failed only when the whole suite ran, and never alone.
 */
const waitForQueue = async (running: number, waiting: number) => {
  // Waited out in wall-clock time rather than in event-loop turns: reaching the
  // queue means reading the cache off disk first, and a machine under load can
  // spend more real time on that read than a few hundred immediate callbacks
  // take to burn through. Counting turns is how a wait like this looks patient
  // and is not.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const depth = renderQueueDepth();
    if (depth.running === running && depth.waiting === waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(
    `queue never reached running=${running} waiting=${waiting}; ` +
      `it is at ${JSON.stringify(renderQueueDepth())}`,
  );
};

describe("rendering a page once", () => {
  beforeEach(() => svgRender.mockClear());

  it("renders and returns it compressed", async () => {
    const result = await getPage(deps({ render: svgRender }), asset, 2);

    expect(result.mimeType).toBe("image/svg+xml");
    expect(result.contentEncoding).toBe("br");
    expect(brotliDecompressSync(result.body).toString()).toContain("page 2");
  });

  it("does not render the same page twice", async () => {
    await getPage(deps({ render: svgRender }), asset, 1);
    await getPage(deps({ render: svgRender }), asset, 1);
    expect(svgRender).toHaveBeenCalledTimes(1);
  });

  it("shares one render between callers arriving together", async () => {
    const slow = vi.fn(async (_p: string, page: number) => {
      await new Promise((r) => setTimeout(r, 30));
      return { body: Buffer.from(`<svg>${page}</svg>`), mimeType: "image/svg+xml" as const };
    });
    await Promise.all([
      getPage(deps({ render: slow }), asset, 5),
      getPage(deps({ render: slow }), asset, 5),
      getPage(deps({ render: slow }), asset, 5),
    ]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("lets a failed render be retried rather than caching the failure", async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("renderer died"))
      .mockResolvedValueOnce({ body: Buffer.from("<svg>ok</svg>"), mimeType: "image/svg+xml" });

    await expect(getPage(deps({ render: flaky }), asset, 3)).rejects.toThrow(/renderer died/);
    const second = await getPage(deps({ render: flaky }), asset, 3);
    expect(brotliDecompressSync(second.body).toString()).toContain("ok");
  });

  it("keeps a raster page uncompressed", async () => {
    const raster = vi.fn(async () => ({
      body: Buffer.from("PNG-ish bytes"),
      mimeType: "image/png" as const,
    }));
    const result = await getPage(deps({ render: raster }), asset, 1);
    expect(result.contentEncoding).toBeNull();
    expect(result.body.toString()).toBe("PNG-ish bytes");
  });

  it("keeps pages of the same document apart", async () => {
    const a = await getPage(deps({ render: svgRender }), asset, 1);
    const b = await getPage(deps({ render: svgRender }), asset, 2);
    expect(brotliDecompressSync(a.body).toString()).toContain("page 1");
    expect(brotliDecompressSync(b.body).toString()).toContain("page 2");
  });

  it("never starts more than the configured number of render jobs", async () => {
    let active = 0;
    let maximum = 0;
    const slowRender = vi.fn(async (_path: string, page: number) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        body: Buffer.from(`<svg width="10" height="10">${page}</svg>`),
        mimeType: "image/svg+xml" as const,
      };
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        getPage(
          deps({ render: slowRender, renderConcurrency: 2 }),
          { id: `doc-${index}`, blob: { storageKey: `originals/doc-${index}` } },
          index + 1,
        ),
      ),
    );

    expect(slowRender).toHaveBeenCalledTimes(8);
    expect(maximum).toBe(2);
  });

  it("rejects distinct pages beyond the bounded render wait queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowRender = vi.fn(async (_path: string, page: number) => {
      if (page === 1) await gate;
      return { body: Buffer.from(`png-${page}`), mimeType: "image/png" as const };
    });
    const options = deps({ render: slowRender, renderConcurrency: 1, renderQueueLimit: 1 });
    const page = (number: number) =>
      getPage(
        options,
        { id: `queued-${number}`, blob: { storageKey: `originals/${number}` } },
        number,
      );

    const first = page(1);
    await waitForQueue(1, 0);
    const second = page(2);
    await waitForQueue(1, 1);
    await expect(page(3)).rejects.toBeInstanceOf(QueueCapacityError);
    release();
    await Promise.all([first, second]);
    expect(slowRender).toHaveBeenCalledTimes(2);
  });

  it("drops a disconnected request from the render wait queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const render = vi.fn(async (_path: string, page: number) => {
      if (page === 10) await gate;
      return { body: Buffer.from(`png-${page}`), mimeType: "image/png" as const };
    });
    const options = deps({ render, renderConcurrency: 1, renderQueueLimit: 1 });
    const first = getPage(
      options,
      { id: "abort-active", blob: { storageKey: "originals/active" } },
      10,
    );
    await waitForQueue(1, 0);
    const controller = new AbortController();
    const waiting = getPage(
      options,
      { id: "abort-waiting", blob: { storageKey: "originals/waiting" } },
      11,
      controller.signal,
    );
    await waitForQueue(1, 1);
    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(QueueAbortedError);
    const replacement = getPage(
      options,
      { id: "abort-replacement", blob: { storageKey: "originals/replacement" } },
      12,
    );
    release();
    await Promise.all([first, replacement]);
    expect(render).not.toHaveBeenCalledWith(expect.anything(), 11);
  });

  it("passes cancellation into an active renderer when its last reader disconnects", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const render = vi.fn(
      async (_path: string, _page: number, _limits: unknown, signal?: AbortSignal) => {
        entered();
        if (!signal) throw new Error("renderer did not receive its abort signal");
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new QueueAbortedError()), { once: true });
        });
        throw new Error("unreachable");
      },
    );
    const controller = new AbortController();
    const rendering = getPage(
      deps({ render }),
      { id: "abort-rendering", blob: { storageKey: "originals/rendering" } },
      13,
      controller.signal,
    );

    await started;
    controller.abort();

    await expect(rendering).rejects.toBeInstanceOf(QueueAbortedError);
    expect(render.mock.calls[0][3]?.aborted).toBe(true);
  });
});

describe("not filling the disk", () => {
  it("refuses to render when free space is below the floor", async () => {
    await expect(
      getPage(deps({ render: svgRender, minFreeDiskPercent: 100 }), asset, 1),
    ).rejects.toBeInstanceOf(DiskFullError);
  });

  it("says how much room there is and how much is needed", async () => {
    const err = await getPage(deps({ render: svgRender, minFreeDiskPercent: 100 }), asset, 1).catch(
      (e) => e,
    );
    expect(err.message).toMatch(/% free/);
    expect(err.message).toMatch(/100% required/);
  });
});

describe("staying under budget", () => {
  const writePage = async (page: number, bytes: number, usedAt: number) => {
    const key = pageCacheKey("doc-1", RENDERER_VERSION, page, ".png");
    await storeStream(storageDir, key, Readable.from([Buffer.alloc(bytes, "x")]), bytes + 1);
    const when = new Date(usedAt);
    await utimes(resolveStoragePath(storageDir, key), when, when);
    return key;
  };

  it("lists cached pages oldest use first", async () => {
    await writePage(1, 100, Date.now() - 60_000);
    await writePage(2, 100, Date.now() - 10_000);
    const entries = await listCached(storageDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].usedAt).toBeLessThan(entries[1].usedAt);
  });

  it("keeps everything while under budget", async () => {
    await writePage(1, 100, Date.now());
    expect(await evictToBudget(deps({ cacheBudgetBytes: 10_000 }))).toBe(0);
    expect(await listCached(storageDir)).toHaveLength(1);
  });

  it("drops the least recently used pages when over budget", async () => {
    await writePage(1, 400, Date.now() - 90_000);
    await writePage(2, 400, Date.now() - 60_000);
    await writePage(3, 400, Date.now() - 10_000);

    const freed = await evictToBudget(deps({ cacheBudgetBytes: 500 }));
    expect(freed).toBeGreaterThan(0);

    const left = await listCached(storageDir);
    // The most recently used one survives.
    expect(left.some((e) => e.key.includes("000003"))).toBe(true);
    expect(left.some((e) => e.key.includes("000001"))).toBe(false);
  });

  it("goes below the ceiling rather than exactly to it", async () => {
    for (let i = 1; i <= 5; i++) await writePage(i, 200, Date.now() - (6 - i) * 1000);
    await evictToBudget(deps({ cacheBudgetBytes: 600 }));
    const total = (await listCached(storageDir)).reduce((s, e) => s + e.bytes, 0);
    expect(total).toBeLessThanOrEqual(540);
  });

  it("survives an empty cache directory", async () => {
    expect(await listCached(storageDir)).toEqual([]);
    expect(await evictToBudget(deps())).toBe(0);
  });

  it("makes room while rendering rather than failing outright", async () => {
    for (let i = 1; i <= 5; i++) await writePage(i, 2000, Date.now() - (6 - i) * 1000);
    await getPage(deps({ render: svgRender, cacheBudgetBytes: 3000 }), asset, 9);

    const total = (await listCached(storageDir)).reduce((s, e) => s + e.bytes, 0);
    expect(total).toBeLessThanOrEqual(3000);
  });

  it("counts only this instance's cache directory", async () => {
    await writePage(1, 100, Date.now());
    const names = await readdir(join(storageDir, "cache"));
    expect(names).toEqual(["doc-1"]);
  });
});
