import fs from "fs";
import path from "path";
import archiver from "archiver";
import { pipeline } from "node:stream/promises";
import { resolveStoragePath } from "../assets/assetStorage";
import type { PrismaClient } from "../generated/client";
import { type BackupLimitOptions, enforceBackupLimits, prepareBackupSpace } from "./backupLimits";

const Database = require("better-sqlite3") as any;

type BackupSchedulerOptions = BackupLimitOptions & {
  prisma: PrismaClient;
  databaseUrl?: string;
  schedule: string | null;
  backupDir: string;
  assetStorageDir: string;
  retentionDays: number;
};

type AuthCleanupOptions = {
  prisma: PrismaClient;
  schedule: string;
  tokenRetentionDays: number;
  auditRetentionDays: number;
};

type MaintenanceSchedulerOptions = {
  backups: BackupSchedulerOptions;
  authCleanup: AuthCleanupOptions;
};

type CronPart = Set<number>;

type ParsedCron = {
  seconds: CronPart;
  minutes: CronPart;
  hours: CronPart;
  daysOfMonth: CronPart;
  months: CronPart;
  daysOfWeek: CronPart;
  daysOfMonthRestricted: boolean;
  daysOfWeekRestricted: boolean;
};

const parseDatabasePath = (databaseUrl?: string): string | null => {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) return null;
  const raw = databaseUrl.replace(/^file:/, "");
  return path.resolve(raw);
};

const timestampForFilename = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

const parseCronPart = (raw: string, min: number, max: number): CronPart => {
  const values = new Set<number>();
  const addRange = (start: number, end: number, step = 1) => {
    if (step <= 0) throw new Error("Cron step must be positive");
    for (let value = start; value <= end; value += step) values.add(value);
  };

  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    const [rangeToken, stepToken] = trimmed.split("/");
    const step = stepToken ? Number(stepToken) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${trimmed}`);

    if (rangeToken === "*") {
      addRange(min, max, step);
      continue;
    }

    if (rangeToken.includes("-")) {
      const [startRaw, endRaw] = rangeToken.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < min ||
        end > max ||
        start > end
      ) {
        throw new Error(`Invalid cron range: ${trimmed}`);
      }
      addRange(start, end, step);
      continue;
    }

    const value = Number(rangeToken);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid cron value: ${trimmed}`);
    }
    values.add(value);
  }

  if (values.size === 0) throw new Error(`Invalid empty cron field: ${raw}`);
  return values;
};

const parseCronSchedule = (raw: string, label: string): ParsedCron => {
  const parts = raw.trim().split(/\s+/);
  const normalized = parts.length === 5 ? ["0", ...parts] : parts;
  if (normalized.length !== 6) {
    throw new Error(`${label} must be a 5- or 6-field cron expression`);
  }

  return {
    seconds: parseCronPart(normalized[0], 0, 59),
    minutes: parseCronPart(normalized[1], 0, 59),
    hours: parseCronPart(normalized[2], 0, 23),
    daysOfMonth: parseCronPart(normalized[3], 1, 31),
    months: parseCronPart(normalized[4], 1, 12),
    daysOfWeek: parseCronPart(normalized[5], 0, 7),
    daysOfMonthRestricted: normalized[3] !== "*",
    daysOfWeekRestricted: normalized[5] !== "*",
  };
};

const cronMatches = (cron: ParsedCron, date: Date): boolean => {
  const day = date.getDay();
  const dayOfMonthMatches = cron.daysOfMonth.has(date.getDate());
  const dayOfWeekMatches = cron.daysOfWeek.has(day) || (day === 0 && cron.daysOfWeek.has(7));
  const dayMatches =
    cron.daysOfMonthRestricted && cron.daysOfWeekRestricted
      ? dayOfMonthMatches || dayOfWeekMatches
      : dayOfMonthMatches && dayOfWeekMatches;
  return (
    cron.seconds.has(date.getSeconds()) &&
    cron.minutes.has(date.getMinutes()) &&
    cron.hours.has(date.getHours()) &&
    cron.months.has(date.getMonth() + 1) &&
    dayMatches
  );
};

const pruneOldBackups = async (backupDir: string, retentionDays: number): Promise<void> => {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const partialCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(backupDir, { withFileTypes: true });
  await Promise.allSettled(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (/^excalidash-(?:sqlite-.*\.db|backup-.*\.zip(?:\.part)?)$/.test(entry.name) ||
            /^\.excalidash-.*\.sqlite\.part(?:-shm|-wal)?$/.test(entry.name)),
      )
      .map(async (entry) => {
        const filePath = path.join(backupDir, entry.name);
        const stat = await fs.promises.stat(filePath);
        // `-shm`/`-wal` are the sidecars a read-only open of a WAL-mode copy
        // leaves next to the `.part`; they age out on the same clock.
        const partial = /\.part(?:-shm|-wal)?$/.test(entry.name);
        if (
          (partial && stat.mtimeMs < partialCutoff) ||
          (!partial && Number.isFinite(retentionDays) && retentionDays > 0 && stat.mtimeMs < cutoff)
        ) {
          await fs.promises.unlink(filePath);
        }
      }),
  );
};

const backupSecrets = async (databasePath: string) => {
  const secretNames = [".jwt_secret", ".csrf_secret"];
  const secrets: Array<{ sourcePath: string; archivePath: string }> = [];
  for (const name of secretNames) {
    const sourcePath = path.join(path.dirname(databasePath), name);
    try {
      const info = await fs.promises.lstat(sourcePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Persisted secret is not a regular file: ${sourcePath}`);
      }
      secrets.push({ sourcePath, archivePath: `secrets/${name}` });
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return secrets;
};

export const createSqliteBackup = async ({
  prisma,
  databaseUrl,
  backupDir,
  assetStorageDir,
  retentionDays,
  maxCount,
  maxTotalBytes,
  minFreeDiskPercent,
}: Omit<BackupSchedulerOptions, "schedule">): Promise<string | null> => {
  const databasePath = parseDatabasePath(databaseUrl);
  if (!databasePath) {
    console.warn(
      "[backup] Scheduled backups currently support SQLite file: DATABASE_URL values only.",
    );
    return null;
  }

  // Backups contain a full copy of the database (password hashes, API-key
  // hashes, OIDC secrets), so restrict the directory and files to the owner.
  await fs.promises.mkdir(backupDir, { recursive: true, mode: 0o700 });
  // Prune before allocating another complete copy. Otherwise a full disk can
  // make retention ineffective precisely when it is needed most.
  await pruneOldBackups(backupDir, retentionDays);
  // Checkpoint before estimating the database copy. Otherwise pages still in
  // the WAL could make the copy larger than the preflight calculation.
  // queryRaw rather than executeRaw: this PRAGMA answers with a row, and
  // SQLite refuses a statement that returns results through executeRaw.
  await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(PASSIVE)");
  const policy = await prepareBackupSpace({
    backupDir,
    databasePath,
    assetStorageDir,
    maxCount,
    maxTotalBytes,
    minFreeDiskPercent,
  });

  const timestamp = timestampForFilename(new Date());
  const target = path.join(backupDir, `excalidash-backup-${timestamp}.zip`);
  const partialTarget = `${target}.part`;
  const databaseCopy = path.join(backupDir, `.excalidash-${timestamp}-${process.pid}.sqlite.part`);
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(databaseCopy);
  } finally {
    source.close();
  }

  try {
    const copied = new Database(databaseCopy, { readonly: true, fileMustExist: true });
    let storageKeys: string[] = [];
    try {
      try {
        storageKeys = copied
          .prepare('SELECT "storageKey" FROM "StoredBlob" WHERE "state" = ? ORDER BY "storageKey"')
          .all("READY")
          .map((row: { storageKey: string }) => row.storageKey);
      } catch (error: any) {
        // Databases from before document assets existed remain backupable.
        if (!String(error?.message ?? error).includes("no such table")) throw error;
      }
    } finally {
      copied.close();
    }

    const originalsRoot = resolveStoragePath(assetStorageDir, "originals");
    const originals: Array<{ sourcePath: string; archivePath: string }> = [];
    for (const storageKey of storageKeys) {
      const sourcePath = resolveStoragePath(assetStorageDir, storageKey);
      const relative = path.relative(originalsRoot, sourcePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Stored blob is not under originals/: ${storageKey}`);
      }
      const stat = await fs.promises.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Stored blob is not a regular file: ${storageKey}`);
      }
      originals.push({
        sourcePath,
        archivePath: `assets/originals/${relative.split(path.sep).join("/")}`,
      });
    }
    const secrets = await backupSecrets(databasePath);

    const archive = archiver("zip", { zlib: { level: 6 } });
    const output = fs.createWriteStream(partialTarget, { mode: 0o600 });
    const writing = pipeline(archive, output);
    archive.append(fs.createReadStream(databaseCopy), { name: "database.sqlite" });
    archive.append(
      JSON.stringify(
        {
          format: "excalidash-server-backup",
          formatVersion: 2,
          createdAt: new Date().toISOString(),
          database: "database.sqlite",
          originals: originals.length,
          secrets: secrets.map((secret) => secret.archivePath),
        },
        null,
        2,
      ),
      { name: "backup.manifest.json" },
    );
    for (const original of originals) {
      // Stored originals are usually already PDF/Brotli-compressed. Store mode
      // avoids wasting CPU and keeps the entire operation stream-based.
      archive.append(fs.createReadStream(original.sourcePath), {
        name: original.archivePath,
        store: true,
      });
    }
    for (const secret of secrets) {
      archive.append(fs.createReadStream(secret.sourcePath), {
        name: secret.archivePath,
      });
    }
    await archive.finalize();
    await writing;
    await fs.promises.rename(partialTarget, target);
    await fs.promises.chmod(target, 0o600);
    const completedSize = (await fs.promises.stat(target)).size;
    if (completedSize > policy.maxTotalBytes) {
      await fs.promises.rm(target, { force: true });
      throw new Error(
        `[backup] Completed archive exceeded BACKUP_MAX_TOTAL_MB and was removed: ${target}`,
      );
    }
    await pruneOldBackups(backupDir, retentionDays);
    await enforceBackupLimits(backupDir, policy.maxCount, policy.maxTotalBytes);
    console.log(
      `[backup] Wrote database, ${originals.length} originals, and ${secrets.length} secrets: ${target}`,
    );
    return target;
  } catch (error) {
    await fs.promises.rm(partialTarget, { force: true });
    throw error;
  } finally {
    // Reading the copy's blob table opens it read-only, and a read-only
    // connection can neither checkpoint nor unlink the `-shm`/`-wal` it creates
    // for a WAL-mode database. Dropping only the copy strands them for good.
    await Promise.all(
      [databaseCopy, `${databaseCopy}-shm`, `${databaseCopy}-wal`].map((file) =>
        fs.promises.rm(file, { force: true }),
      ),
    );
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const cleanupExpiredAuthData = async ({
  prisma,
  tokenRetentionDays,
  auditRetentionDays,
  now = new Date(),
}: Omit<AuthCleanupOptions, "schedule"> & { now?: Date }) => {
  const tokenCutoff = new Date(now.getTime() - tokenRetentionDays * DAY_MS);
  const auditCutoff = new Date(now.getTime() - auditRetentionDays * DAY_MS);

  // Recent terminal tokens remain available for incident investigation. Live
  // tokens are never selected, regardless of age.
  const refreshTokens = await prisma.refreshToken.deleteMany({
    where: {
      createdAt: { lt: tokenCutoff },
      OR: [{ revoked: true }, { expiresAt: { lt: now } }],
    },
  });
  const passwordResetTokens = await prisma.passwordResetToken.deleteMany({
    where: {
      createdAt: { lt: tokenCutoff },
      OR: [{ used: true }, { expiresAt: { lt: now } }],
    },
  });
  const auditLogs = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: auditCutoff } },
  });

  const counts = {
    refreshTokens: refreshTokens.count,
    passwordResetTokens: passwordResetTokens.count,
    auditLogs: auditLogs.count,
  };
  console.log("[maintenance] Auth retention cleanup completed", counts);
  return counts;
};

export const startScheduledMaintenance = (
  options: MaintenanceSchedulerOptions,
): (() => void) | null => {
  const jobs: Array<{
    name: string;
    cron: ParsedCron;
    run: () => Promise<unknown>;
    lastRunKey: string | null;
    running: boolean;
  }> = [];

  const addJob = (name: string, schedule: string | null, run: () => Promise<unknown>) => {
    if (!schedule) return;
    try {
      jobs.push({
        name,
        cron: parseCronSchedule(schedule, name),
        run,
        lastRunKey: null,
        running: false,
      });
    } catch (error) {
      console.error(`[maintenance] Invalid ${name}; job disabled:`, error);
    }
  };

  addJob("BACKUP_SCHEDULE", options.backups.schedule, () => createSqliteBackup(options.backups));
  addJob("AUTH_CLEANUP_SCHEDULE", options.authCleanup.schedule, () =>
    cleanupExpiredAuthData(options.authCleanup),
  );
  if (jobs.length === 0) return null;

  const tick = async () => {
    const now = new Date();
    const runKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`;
    await Promise.all(
      jobs.map(async (job) => {
        if (!cronMatches(job.cron, now) || job.lastRunKey === runKey || job.running) return;
        job.lastRunKey = runKey;
        job.running = true;
        try {
          await job.run();
        } catch (error) {
          console.error(`[maintenance] ${job.name} failed:`, error);
        } finally {
          job.running = false;
        }
      }),
    );
  };

  const interval = setInterval(() => void tick(), 1000);
  interval.unref();
  console.log(`[maintenance] Scheduled jobs enabled: ${jobs.map((job) => job.name).join(", ")}`);
  return () => clearInterval(interval);
};
