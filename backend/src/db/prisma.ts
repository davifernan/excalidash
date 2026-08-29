import fs from "fs";
import path from "path";
import { PrismaClient } from "../generated/client";
import { logger } from "../logger";
import { config } from "../config";

declare global {
  // eslint-disable-next-line no-var
  var __excalidashPrisma: PrismaClient | undefined;
}

// NIL-668: SQLite is single-writer. SQLITE_BUSY_TIMEOUT_MS below (applied as
// `PRAGMA busy_timeout`) makes a blocked writer wait for a lock instead of
// failing immediately -- but Prisma's OWN interactive-transaction timeout
// defaulted to that exact same 5000ms, racing the same clock with zero
// designed margin. Any transaction that has to wait on busy_timeout for even
// a large fraction of that window before its actual queries run was then cut
// off by Prisma's own timeout before it could finish, regardless of how
// little real work it had left -- exactly the shape measured on NIL-668 (all
// observed overruns were under 100ms past the 5000ms ceiling, consistent
// with "the wait alone nearly exhausted the budget"). Concurrency here is
// not Playwright's test workers (already 1) but the application's own:
// several sockets independently joining the same board each open their own
// multi-query `socketDocumentPages.ts` snapshot transaction, and SQLite
// serializes them.
//
// Both clocks moved together, not just Prisma's outer one: this PR's own
// first CI run still hit a SEPARATE SQLite-side failure ("Operations timed
// out after `N/A`. Context: the database failed to respond ...", no
// "however N ms passed" line) -- that message is busy_timeout itself
// expiring, a distinct clock from Prisma's transactionOptions.timeout, and
// raising only the Prisma-side clock does nothing for it. Both get raised
// together, keeping the same real margin between them.
//
// Kept as one named constant, not two independent literals, so
// SQLITE_TRANSACTION_TIMEOUT_MS below can never silently drift back to
// equaling it -- see prisma.transactionOptions.test.ts, which asserts the
// margin directly rather than trusting the comment.
export const SQLITE_BUSY_TIMEOUT_MS = 8000;
// Total transaction lifetime, INCLUDING any busy_timeout wait a query inside
// it hits. Must clear SQLITE_BUSY_TIMEOUT_MS with real margin for the
// queries that follow lock acquisition.
export const SQLITE_TRANSACTION_TIMEOUT_MS = 12000;
// Time to acquire a slot to START a transaction, separate from
// SQLITE_TRANSACTION_TIMEOUT_MS above (which only starts counting once a
// transaction has begun). Matches SQLITE_BUSY_TIMEOUT_MS: a queue of several
// same-shaped snapshot transactions piling up from concurrent socket joins
// can make even STARTING one wait roughly as long as a write-lock wait
// would.
export const SQLITE_TRANSACTION_MAX_WAIT_MS = 8000;

// Scoped to SQLite only (same `file:` check configureSqlite below uses) so a
// PostgreSQL deployment is untouched -- Postgres has no comparable single-
// writer wait to race against in the first place.
export const isSqliteDatabase = (databaseUrl: string | undefined): boolean =>
  !databaseUrl || databaseUrl.startsWith("file:");

const prismaClient =
  globalThis.__excalidashPrisma ??
  new PrismaClient(
    isSqliteDatabase(config.databaseUrl)
      ? {
          transactionOptions: {
            maxWait: SQLITE_TRANSACTION_MAX_WAIT_MS,
            timeout: SQLITE_TRANSACTION_TIMEOUT_MS,
          },
        }
      : undefined,
  );

if (config.nodeEnv !== "production") {
  globalThis.__excalidashPrisma = prismaClient;
}

/**
 * Enable WAL journal mode and set a busy timeout for SQLite.
 * WAL allows concurrent reads during writes; busy_timeout makes writers
 * wait instead of failing immediately when the database is locked.
 *
 * Awaitable so the server bootstrap can ensure subsequent queries run
 * with WAL + busy_timeout already applied.
 */
export async function configureSqlite(): Promise<void> {
  const databaseUrl = config.databaseUrl ?? "";
  // PRAGMA statements only apply to SQLite; skip them for other providers.
  if (databaseUrl && !databaseUrl.startsWith("file:")) {
    return;
  }
  try {
    // Order matters: PRAGMA journal_mode = WAL has to acquire the write
    // lock briefly, and without busy_timeout it fails immediately on
    // contention — the exact bootstrap race this fix exists to mitigate.
    // Set busy_timeout first so the WAL switch can wait for any lock the
    // initial Prisma client setup may have left in flight.
    //
    // PRAGMA statements return rows (busy_timeout returns 8000,
    // journal_mode returns "wal"), so we use $queryRaw — the tagged-
    // template form rejects accidental interpolation, and accepts the
    // returned row. The literal below must match SQLITE_BUSY_TIMEOUT_MS
    // above (interpolating it here would parameterize the PRAGMA's value,
    // which this deliberately avoids -- see the comment on $queryRaw just
    // above); prisma.transactionOptions.test.ts checks the two stay equal
    // by reading this file's own source rather than trusting the comment.
    await prismaClient.$queryRaw`PRAGMA busy_timeout = 8000;`;
    await prismaClient.$queryRaw`PRAGMA journal_mode = WAL;`;
    await enableIncrementalAutoVacuumOnSmallDatabase();
  } catch (err) {
    // Surface real failures (e.g. permission, corrupted db) instead of swallowing.
    logger.warn("failed to configure SQLite PRAGMAs", { error: err });
  }
}

export { prismaClient as prisma };

/**
 * Return space freed by deleted rows to the filesystem.
 *
 * SQLite keeps the pages of deleted rows on a free list instead of shrinking
 * the file, so a database that prunes on a schedule only ever grows: after the
 * snapshot retention had cleared every row on one instance, 218 MB of file
 * held 10 MB of data.
 *
 * VACUUM rewrites the file, which means an exclusive lock and room for a
 * second copy while it runs. It is therefore rare by construction: a large
 * absolute amount has to be free, a large share of the file has to be free,
 * and the previous run has to be days ago.
 */
const VACUUM_MARKER_FILE = ".last-vacuum";
const VACUUM_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024;
const VACUUM_MIN_FREE_RATIO = 0.3;
/** Above this, tolerating the free list wastes more than a rewrite costs. */
const VACUUM_ALWAYS_ABOVE_BYTES = 1024 * 1024 * 1024;

const getSqliteFilePath = (databaseUrl: string): string | null =>
  databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : null;

/** Survives restarts — an in-memory cooldown would be reset by every deploy. */
const readLastVacuum = async (markerPath: string): Promise<number> => {
  try {
    const raw = await fs.promises.readFile(markerPath, "utf8");
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
};

export async function reclaimSqliteFreeSpace(): Promise<{
  reclaimedBytes: number;
  durationMs: number;
} | null> {
  if (!config.enableSnapshotVacuum) return null;

  const databaseUrl = config.databaseUrl ?? "";
  // VACUUM is SQLite-specific; PostgreSQL maintains itself through autovacuum.
  const dbPath = getSqliteFilePath(databaseUrl);
  if (databaseUrl && !dbPath) return null;

  try {
    const markerPath = dbPath ? path.join(path.dirname(dbPath), VACUUM_MARKER_FILE) : null;

    const [pageCount, freeCount, pageSize, autoVacuum] = await Promise.all([
      readPragmaNumber("page_count"),
      readPragmaNumber("freelist_count"),
      readPragmaNumber("page_size"),
      readPragmaNumber("auto_vacuum"),
    ]);
    if (!pageCount || !pageSize) return null;

    const freeBytesNow = freeCount * pageSize;

    // Incremental mode returns pages without rewriting the file: no exclusive
    // lock on the whole database, no second copy on disk, no cooldown needed.
    if (autoVacuum === AUTO_VACUUM_INCREMENTAL) {
      if (freeBytesNow < INCREMENTAL_MIN_FREE_BYTES) return null;
      const pages = Math.min(freeCount, INCREMENTAL_VACUUM_PAGE_BUDGET);
      const startedAt = Date.now();
      await prismaClient.$executeRawUnsafe(`PRAGMA incremental_vacuum(${pages})`);
      const durationMs = Date.now() - startedAt;
      const reclaimedBytes = pages * pageSize;
      logger.info("sqlite cleanup returned free pages incrementally", {
        reclaimedMb: Number((reclaimedBytes / 1024 / 1024).toFixed(1)),
        durationMs,
      });
      return { reclaimedBytes, durationMs };
    }

    // From here on this is the one-time conversion of a legacy database.
    if (markerPath) {
      const last = await readLastVacuum(markerPath);
      if (last && Date.now() - last < VACUUM_COOLDOWN_MS) return null;
    }

    const freeBytes = freeBytesNow;
    const fileBytes = pageCount * pageSize;
    const freeRatio = freeCount / pageCount;
    const worthIt =
      freeBytes >= VACUUM_ALWAYS_ABOVE_BYTES ||
      (freeBytes >= VACUUM_MIN_FREE_BYTES && freeRatio >= VACUUM_MIN_FREE_RATIO);
    if (!worthIt) return null;

    // A rewrite needs room for a second copy. Running out mid-way would fill
    // the volume of an installation that is already short on space.
    if (dbPath) {
      try {
        const stats = await fs.promises.statfs(path.dirname(dbPath));
        const availableBytes = Number(stats.bavail) * Number(stats.bsize);
        if (availableBytes < fileBytes * 2) {
          logger.warn("sqlite cleanup skipping VACUUM: insufficient free space", {
            neededMb: ((fileBytes * 2) / 1024 / 1024) | 0,
            availableMb: (availableBytes / 1024 / 1024) | 0,
          });
          return null;
        }
      } catch {
        // Cannot tell — better to skip than to risk filling the volume.
        return null;
      }
    }

    const startedAt = Date.now();
    // Switch to incremental mode in the same rewrite, so this is the last full
    // VACUUM this database ever needs.
    await prismaClient.$queryRawUnsafe("PRAGMA auto_vacuum = INCREMENTAL");
    // VACUUM cannot run inside a transaction, so it goes out on its own.
    await prismaClient.$executeRawUnsafe("VACUUM");
    const durationMs = Date.now() - startedAt;

    if (markerPath) {
      await fs.promises.writeFile(markerPath, String(Date.now()), "utf8").catch(() => undefined);
    }

    logger.info("sqlite cleanup VACUUM reclaimed space", {
      reclaimedMb: Number((freeBytes / 1024 / 1024).toFixed(1)),
      fileMb: Number((fileBytes / 1024 / 1024).toFixed(1)),
      freePercent: Number((freeRatio * 100).toFixed(0)),
      durationMs,
    });
    return { reclaimedBytes: freeBytes, durationMs };
  } catch (error) {
    // Never let housekeeping take the server down.
    logger.error("sqlite cleanup VACUUM failed", { error });
    return null;
  }
}

const AUTO_VACUUM_NONE = 0;
const AUTO_VACUUM_INCREMENTAL = 2;
/** Below this a full rewrite is instant and needs no meaningful headroom. */
const AUTO_VACUUM_CONVERT_BELOW_BYTES = 8 * 1024 * 1024;
/** Pages handed back per pass — bounded so a cleanup tick stays short. */
const INCREMENTAL_VACUUM_PAGE_BUDGET = 20_000;
/** Reclaiming a few megabytes is not worth the write amplification. */
const INCREMENTAL_MIN_FREE_BYTES = 8 * 1024 * 1024;

const readPragmaNumber = async (name: string): Promise<number> => {
  const rows = await prismaClient.$queryRawUnsafe<Array<Record<string, unknown>>>(`PRAGMA ${name}`);
  const value = rows?.[0] ? Object.values(rows[0])[0] : 0;
  return Number(value ?? 0);
};

/**
 * Switch small databases to incremental auto-vacuum.
 *
 * In incremental mode SQLite can hand free pages back without rewriting the
 * file, so no full VACUUM — and none of its exclusive lock or double disk
 * usage — is ever needed again. The mode can only be changed by rewriting the
 * file, which is why this only runs while that is still cheap: on a fresh
 * install it is effectively free. Larger existing databases are converted by
 * the one-time full VACUUM in reclaimSqliteFreeSpace instead.
 */
async function enableIncrementalAutoVacuumOnSmallDatabase(): Promise<void> {
  const mode = await readPragmaNumber("auto_vacuum");
  if (mode !== AUTO_VACUUM_NONE) return;

  const [pageCount, pageSize] = await Promise.all([
    readPragmaNumber("page_count"),
    readPragmaNumber("page_size"),
  ]);
  if (pageCount * pageSize > AUTO_VACUUM_CONVERT_BELOW_BYTES) return;

  await prismaClient.$queryRawUnsafe("PRAGMA auto_vacuum = INCREMENTAL");
  // The setting only takes hold once the file has been rewritten.
  await prismaClient.$executeRawUnsafe("VACUUM");
  logger.info("sqlite switched to incremental auto-vacuum");
}
