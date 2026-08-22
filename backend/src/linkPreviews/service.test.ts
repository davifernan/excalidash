import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewFetchError } from "./network";
import { createLinkPreviewService, FAILURE_FLOOR_MS, LinkPreviewBusyError } from "./service";
import { fakePreviewPrisma, previewTestConfig as config } from "./testSupport";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function withHttpServer<T>(
  handler: Parameters<typeof createServer>[0],
  work: (port: number) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP port");
  try {
    return await work(address.port);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

describe("link preview caching and admission", () => {
  it("serves repeated successful requests from the persistent cache", async () => {
    const prisma = fakePreviewPrisma();
    const fetchResource = vi.fn().mockResolvedValue({
      body: Buffer.from(
        '<html><head><title>Cached title</title><link rel="icon" href="data:,x"></head>',
      ),
      finalUrl: new URL("https://example.com/final"),
      contentType: "text/html",
      headers: {},
    });
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config,
      fetchResource,
    });

    expect((await getPreview("user-1", "https://example.com/start")).title).toBe("Cached title");
    expect((await getPreview("user-1", "https://example.com/start#fragment")).title).toBe(
      "Cached title",
    );
    expect(fetchResource).toHaveBeenCalledTimes(1);
  });

  it("caches one public failure code so a bad target is not fetched repeatedly", async () => {
    const prisma = fakePreviewPrisma();
    const fetchResource = vi
      .fn()
      .mockRejectedValue(new PreviewFetchError("TOO_LARGE", "too large"));
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config,
      fetchResource,
      logger: { warn: vi.fn() },
      delay: async () => undefined,
    });

    expect((await getPreview("user-1", "https://example.com/huge")).failureCode).toBe(
      "UNAVAILABLE",
    );
    expect((await getPreview("user-1", "https://example.com/huge")).failureCode).toBe(
      "UNAVAILABLE",
    );
    expect(fetchResource).toHaveBeenCalledTimes(1);
  });

  it("makes blocked and unreachable hosts outwardly indistinguishable", async () => {
    const outcomes = [
      new PreviewFetchError("SSRF_BLOCKED", "private address"),
      new PreviewFetchError("NETWORK_ERROR", "name not found"),
    ];
    const observed: Array<{ code: string | null; delay: number }> = [];
    const warnings: string[] = [];
    for (const [index, failure] of outcomes.entries()) {
      let delayed = 0;
      const getPreview = createLinkPreviewService({
        prisma: fakePreviewPrisma(),
        storageDir: "/unused",
        config,
        fetchResource: vi.fn().mockRejectedValue(failure),
        logger: { warn: (message) => warnings.push(String(message)) },
        delay: async (ms) => {
          delayed = ms;
        },
      });
      const result = await getPreview(`user-${index}`, `https://${index}.example.test`);
      observed.push({ code: result.failureCode, delay: delayed });
    }

    expect(observed.map(({ code }) => code)).toEqual(["UNAVAILABLE", "UNAVAILABLE"]);
    // Written out rather than taken from the constant under test: comparing a
    // value against itself passes however the service behaves, including with
    // the wait removed altogether. Lowering the floor is a security decision,
    // so it should have to be made here as well.
    expect(observed.every(({ delay }) => delay >= 1_500)).toBe(true);
    expect(FAILURE_FLOOR_MS).toBeGreaterThanOrEqual(1_500);
    // Alike, not identical: both waits are computed from the clock, so they
    // differ by a millisecond now and then. Demanding equality made this test
    // fail roughly one run in three.
    expect(Math.abs(observed[0].delay - observed[1].delay)).toBeLessThanOrEqual(50);
    expect(warnings.join("\n")).toContain("SSRF_BLOCKED");
    expect(warnings.join("\n")).toContain("NETWORK_ERROR");
    expect(warnings.join("\n")).not.toContain("0.example.test");
    expect(warnings.join("\n")).not.toContain("private address");
  });

  it("really waits, rather than reporting a wait it never took", async () => {
    // Every other test here hands in a delay function that resolves at once and
    // then inspects the number it was given. Replacing the production wait with
    // `() => Promise.resolve()` leaves all of those green while the service
    // answers instantly and the timing difference is back.
    const getPreview = createLinkPreviewService({
      prisma: fakePreviewPrisma(),
      storageDir: "/unused",
      config,
      fetchResource: vi.fn().mockRejectedValue(new PreviewFetchError("SSRF_BLOCKED", "private")),
      logger: { warn: () => {} },
    });

    const startedAt = Date.now();
    const result = await getPreview("user-slow", "https://slow.example.test");
    const elapsed = Date.now() - startedAt;

    expect(result.failureCode).toBe("UNAVAILABLE");
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
  }, 10_000);

  it("coalesces concurrent requests for the same actor and address", async () => {
    const prisma = fakePreviewPrisma();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchResource = vi.fn().mockImplementation(async () => {
      await held;
      return {
        body: Buffer.from('<head><title>One fetch</title><link rel="icon" href="data:,x"></head>'),
        finalUrl: new URL("https://example.com"),
        contentType: "text/html",
        headers: {},
      };
    });
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config,
      fetchResource,
    });
    const first = getPreview("user-1", "https://example.com");
    const second = getPreview("user-1", "https://example.com");
    await vi.waitFor(() => expect(fetchResource).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(fetchResource).toHaveBeenCalledTimes(1);
  });

  it("isolates the persistent cache between actors", async () => {
    const prisma = fakePreviewPrisma();
    const fetchResource = vi.fn().mockResolvedValue({
      body: Buffer.from(
        '<head><title>Private timing</title><link rel="icon" href="data:,none"></head>',
      ),
      finalUrl: new URL("https://example.com"),
      contentType: "text/html",
      headers: {},
    });
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config,
      fetchResource,
    });

    await getPreview("user-1", "https://example.com");
    await getPreview("user-2", "https://example.com");

    expect(fetchResource).toHaveBeenCalledTimes(2);
    expect([...prisma.rows.values()].map((row: any) => row.ownerUserId).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("limits simultaneous preview work per user", async () => {
    const prisma = fakePreviewPrisma();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchResource = vi.fn().mockImplementation(async () => {
      await held;
      return {
        body: Buffer.from('<head><title>Done</title><link rel="icon" href="data:,x"></head>'),
        finalUrl: new URL("https://example.com"),
        contentType: "text/html",
        headers: {},
      };
    });
    const getPreview = createLinkPreviewService({
      prisma,
      storageDir: "/unused",
      config,
      fetchResource,
    });
    const first = getPreview("user-1", "https://one.example");
    await vi.waitFor(() => expect(fetchResource).toHaveBeenCalledTimes(1));
    await expect(getPreview("user-1", "https://two.example")).rejects.toBeInstanceOf(
      LinkPreviewBusyError,
    );
    release();
    await first;
  });

  it("fetches a valid page and its image through the same pinned HTTP path", async () => {
    const seen: string[] = [];
    await withHttpServer(
      (request, response) => {
        seen.push(request.url ?? "");
        if (request.url === "/page") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<head><title>Real service</title><meta property="og:image" content="/image.png"><link rel="icon" href="data:,none"></head>',
          );
          return;
        }
        response.setHeader("Content-Type", "image/png");
        response.end(Buffer.from("89504e470d0a1a0a", "hex"));
      },
      async (port) => {
        const prisma = fakePreviewPrisma();
        const storageDir = await mkdtemp(join(tmpdir(), "link-preview-service-"));
        tempDirs.push(storageDir);
        const getPreview = createLinkPreviewService({
          prisma,
          storageDir,
          config: { ...config, allowedPorts: [port] },
          networkDeps: {
            lookup: async () => [{ address: "93.184.216.34", family: 4 }],
            connect: (options: any) => {
              expect(options.host ?? options.hostname).toBe("93.184.216.34");
              return netConnect({ host: "127.0.0.1", port });
            },
          },
          sanitizeImage: vi.fn(async () => Buffer.from("sanitized-webp")),
        });

        const result = await getPreview("user-1", `http://public.test:${port}/page`);
        expect(result.title).toBe("Real service");
        expect(result.imageBlobId).toBeTruthy();
        expect(seen).toEqual(["/page", "/image.png"]);
      },
    );
  });
});
