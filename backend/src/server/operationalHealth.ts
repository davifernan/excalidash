import fs from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";
import { freeDiskPercent } from "../assets/pageCache";
import { logger } from "../logger";

const COMPLETED_BACKUP = /^excalidash-(?:backup-.*\.zip|sqlite-.*\.db)$/;

export type DatabaseWriteClient = {
  $executeRawUnsafe: (query: string) => PromiseLike<unknown>;
};

type OperationalHealthOptions = {
  database: DatabaseWriteClient;
  diskPath: string;
  minFreeDiskPercent: number;
  backupSchedule: string | null;
  backupDir: string;
  backupMaxAgeMs: number;
  cacheTtlMs: number;
  now?: () => number;
  readFreeDiskPercent?: typeof freeDiskPercent;
};

type DatabaseCheck = {
  status: "ok" | "error";
  writable: boolean;
};

type DiskCheck = {
  status: "ok" | "critical" | "unknown";
  freePercent: number | null;
  minimumFreePercent: number;
};

type BackupCheck = {
  status: "ok" | "stale" | "missing" | "unavailable" | "disabled";
  scheduled: boolean;
  latestSuccessfulAt: string | null;
  ageSeconds: number | null;
  maximumAgeSeconds: number;
};

type ReadinessCore = {
  status: "ok" | "warning" | "error";
  checkedAt: string;
  checks: {
    database: DatabaseCheck;
    disk: DiskCheck;
    backup: BackupCheck;
  };
};

export type ReadinessReport = ReadinessCore & {
  cache: {
    ttlMs: number;
    ageMs: number;
  };
};

/**
 * Acquire the database writer path without changing durable data. SQLite opens
 * a write transaction for this statement even though the predicate matches no
 * rows, so read-only filesystems and writer-lock failures are observable.
 */
export const assertDatabaseWritable = async (database: DatabaseWriteClient): Promise<void> => {
  await database.$executeRawUnsafe('UPDATE "SystemConfig" SET "id" = "id" WHERE 1 = 0');
};

export const resolveReadinessDiskPath = (
  databaseUrl: string | undefined,
  assetStorageDir: string,
): string => {
  if (!databaseUrl?.startsWith("file:")) return assetStorageDir;
  const databasePath = databaseUrl.slice("file:".length).split("?", 1)[0];
  return path.dirname(databasePath);
};

const checkDatabase = async (database: DatabaseWriteClient): Promise<DatabaseCheck> => {
  try {
    await assertDatabaseWritable(database);
    return { status: "ok", writable: true };
  } catch (error) {
    logger.error("Readiness database check failed", { error });
    return { status: "error", writable: false };
  }
};

const checkDisk = async (
  diskPath: string,
  minimumFreePercent: number,
  readFree: typeof freeDiskPercent,
): Promise<DiskCheck> => {
  try {
    const freePercent = await readFree(diskPath);
    if (freePercent === null) {
      return { status: "unknown", freePercent: null, minimumFreePercent };
    }
    const reportedFreePercent = Math.round(freePercent * 10) / 10;
    return {
      status: reportedFreePercent < minimumFreePercent ? "critical" : "ok",
      freePercent: reportedFreePercent,
      minimumFreePercent,
    };
  } catch (error) {
    logger.error("Readiness disk check failed", { error });
    return { status: "unknown", freePercent: null, minimumFreePercent };
  }
};

const checkBackup = async (
  schedule: string | null,
  backupDir: string,
  maximumAgeMs: number,
  checkedAtMs: number,
): Promise<BackupCheck> => {
  const maximumAgeSeconds = Math.floor(maximumAgeMs / 1000);
  if (!schedule) {
    return {
      status: "disabled",
      scheduled: false,
      latestSuccessfulAt: null,
      ageSeconds: null,
      maximumAgeSeconds,
    };
  }

  try {
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const completed = entries.filter(
      (entry) => entry.isFile() && COMPLETED_BACKUP.test(entry.name),
    );
    const stats = await Promise.allSettled(
      completed.map(async (entry) => fs.stat(path.join(backupDir, entry.name))),
    );
    const latestMtimeMs = stats.reduce<number | null>((latest, result) => {
      if (result.status !== "fulfilled") return latest;
      return latest === null ? result.value.mtimeMs : Math.max(latest, result.value.mtimeMs);
    }, null);
    if (latestMtimeMs === null) {
      return {
        status: completed.length > 0 ? "unavailable" : "missing",
        scheduled: true,
        latestSuccessfulAt: null,
        ageSeconds: null,
        maximumAgeSeconds,
      };
    }

    const ageMs = Math.max(0, checkedAtMs - latestMtimeMs);
    return {
      status: ageMs > maximumAgeMs ? "stale" : "ok",
      scheduled: true,
      latestSuccessfulAt: new Date(latestMtimeMs).toISOString(),
      ageSeconds: Math.floor(ageMs / 1000),
      maximumAgeSeconds,
    };
  } catch (error) {
    logger.error("Readiness backup check failed", { error });
    return {
      status: "unavailable",
      scheduled: true,
      latestSuccessfulAt: null,
      ageSeconds: null,
      maximumAgeSeconds,
    };
  }
};

const overallStatus = (
  database: DatabaseCheck,
  disk: DiskCheck,
  backup: BackupCheck,
): ReadinessCore["status"] => {
  if (database.status === "error" || disk.status === "critical") return "error";
  if (disk.status === "unknown") return "warning";
  if (backup.status !== "ok" && backup.status !== "disabled") return "warning";
  return "ok";
};

export const createReadinessProbe = (options: OperationalHealthOptions) => {
  const now = options.now ?? Date.now;
  const readFree = options.readFreeDiskPercent ?? freeDiskPercent;
  let cached: { checkedAtMs: number; report: ReadinessCore } | null = null;
  let inFlight: Promise<{ checkedAtMs: number; report: ReadinessCore }> | null = null;

  const materialize = (entry: { checkedAtMs: number; report: ReadinessCore }): ReadinessReport => ({
    ...entry.report,
    cache: {
      ttlMs: options.cacheTtlMs,
      ageMs: Math.max(0, now() - entry.checkedAtMs),
    },
  });

  const measure = async (): Promise<{ checkedAtMs: number; report: ReadinessCore }> => {
    const checkedAtMs = now();
    const [database, disk, backup] = await Promise.all([
      checkDatabase(options.database),
      checkDisk(options.diskPath, options.minFreeDiskPercent, readFree),
      checkBackup(options.backupSchedule, options.backupDir, options.backupMaxAgeMs, checkedAtMs),
    ]);
    return {
      checkedAtMs,
      report: {
        status: overallStatus(database, disk, backup),
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: { database, disk, backup },
      },
    };
  };

  return async (): Promise<ReadinessReport> => {
    const requestedAt = now();
    if (cached && requestedAt - cached.checkedAtMs < options.cacheTtlMs) {
      return materialize(cached);
    }
    if (!inFlight) {
      inFlight = measure()
        .then((entry) => {
          cached = entry;
          return entry;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return materialize(await inFlight);
  };
};

export const registerOperationalHealthRoutes = (
  app: Express,
  options: OperationalHealthOptions,
): void => {
  const readiness = createReadinessProbe(options);

  // Container restart signal: process existence only, with no database or disk I/O.
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  // Monitoring signal: cached because the database probe acquires the writer path.
  app.get("/ready", async (_req, res) => {
    const report = await readiness();
    res.status(report.status === "error" ? 503 : 200).json(report);
  });
};
