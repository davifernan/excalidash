import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

/**
 * NIL-668: SQLite is single-writer, and `PRAGMA busy_timeout = 5000` (set in
 * configureSqlite below) makes a blocked writer wait up to 5000ms for a lock
 * instead of failing immediately. Prisma's own interactive-transaction
 * timeout defaulted to that exact same 5000ms -- a coincidental collision
 * with zero designed margin: a transaction that had to wait on busy_timeout
 * for most of that window, then still had real queries left to run, was cut
 * off by Prisma's own clock regardless of how little work remained. Measured
 * on ~60 recent "Tests" workflow runs (120 E2E shard jobs): 7 jobs (5.8%),
 * all "E2E Shard 1", showed this signature -- overruns of 18-87ms past the
 * 5000ms ceiling, consistent with "the wait alone nearly exhausted the
 * budget," not a genuinely slow query. Root concurrency source: several
 * sockets independently joining the same board each open their own
 * multi-query snapshot transaction (socketDocumentPages.ts), which SQLite
 * serializes -- not Playwright's test workers, already 1.
 *
 * These tests do not assert "the numbers look reasonable" -- they assert
 * the actual invariant (the transaction ceiling clears the busy_timeout wait
 * with real margin), that the two timeouts can't silently drift apart (one
 * is a JS constant, the other a literal inside a PRAGMA string this file
 * deliberately does not interpolate), and that a PostgreSQL deployment is
 * completely untouched by this SQLite-specific extension.
 */

const { constructorCalls } = vi.hoisted(() => ({
  constructorCalls: [] as Array<unknown>,
}));

vi.mock("../generated/client", () => ({
  PrismaClient: class {
    constructor(options?: unknown) {
      constructorCalls.push(options);
    }
    $queryRaw = vi.fn(async () => [{}]);
    $queryRawUnsafe = vi.fn(async () => [{}]);
    $executeRawUnsafe = vi.fn(async () => undefined);
  },
}));

const PRISMA_SOURCE = fs.readFileSync(path.join(__dirname, "prisma.ts"), "utf8");

const loadPrismaModule = async () =>
  import("./prisma") as Promise<
    typeof import("./prisma") & {
      SQLITE_BUSY_TIMEOUT_MS: number;
      SQLITE_TRANSACTION_TIMEOUT_MS: number;
      SQLITE_TRANSACTION_MAX_WAIT_MS: number;
    }
  >;

describe("prisma.ts SQLite transaction timeout margin", () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    constructorCalls.length = 0;
    // globalThis.__excalidashPrisma is a real global, not module-scoped --
    // vi.resetModules() alone would leave the previous test's singleton in
    // place and this test would never observe a fresh `new PrismaClient()`
    // call.
    delete (globalThis as { __excalidashPrisma?: unknown }).__excalidashPrisma;
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalUrl;
    delete (globalThis as { __excalidashPrisma?: unknown }).__excalidashPrisma;
  });

  it("gives the transaction timeout real margin over the SQLite busy_timeout", async () => {
    const { SQLITE_BUSY_TIMEOUT_MS, SQLITE_TRANSACTION_TIMEOUT_MS } = await loadPrismaModule();
    // Not just "greater than" -- the whole point is a collision at a razor's
    // edge. Require enough headroom to actually run queries after a full
    // busy_timeout wait, not merely a token millisecond more.
    const MINIMUM_MARGIN_MS = 2000;
    expect(SQLITE_TRANSACTION_TIMEOUT_MS - SQLITE_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MINIMUM_MARGIN_MS,
    );
  });

  it("keeps the PRAGMA's literal busy_timeout in sync with SQLITE_BUSY_TIMEOUT_MS", async () => {
    const { SQLITE_BUSY_TIMEOUT_MS } = await loadPrismaModule();
    const match = PRISMA_SOURCE.match(/PRAGMA busy_timeout = (\d+);/);
    expect(match, "expected a literal `PRAGMA busy_timeout = <N>;` in prisma.ts").not.toBeNull();
    expect(Number(match![1])).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it("applies transactionOptions when DATABASE_URL is a SQLite file: URL", async () => {
    process.env.DATABASE_URL = "file:./prisma/test.db";
    const { SQLITE_TRANSACTION_TIMEOUT_MS, SQLITE_TRANSACTION_MAX_WAIT_MS } =
      await loadPrismaModule();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toEqual({
      transactionOptions: {
        maxWait: SQLITE_TRANSACTION_MAX_WAIT_MS,
        timeout: SQLITE_TRANSACTION_TIMEOUT_MS,
      },
    });
  });

  it("applies transactionOptions when DATABASE_URL is unset (SQLite is the default)", async () => {
    delete process.env.DATABASE_URL;
    const { SQLITE_TRANSACTION_TIMEOUT_MS, SQLITE_TRANSACTION_MAX_WAIT_MS } =
      await loadPrismaModule();

    expect(constructorCalls).toHaveLength(1);
    // Hans-Friedrich finding on #237: `not.toBeUndefined()` would not catch
    // a wrong options object on this path -- assert the actual values, the
    // same way the file: URL case above does.
    expect(constructorCalls[0]).toEqual({
      transactionOptions: {
        maxWait: SQLITE_TRANSACTION_MAX_WAIT_MS,
        timeout: SQLITE_TRANSACTION_TIMEOUT_MS,
      },
    });
  });

  it("never applies SQLite transactionOptions for a PostgreSQL DATABASE_URL", async () => {
    process.env.DATABASE_URL = "postgresql://user:pw@localhost:5432/excalidash";
    await loadPrismaModule();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toBeUndefined();
  });
});
