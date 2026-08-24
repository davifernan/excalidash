import fs from "node:fs";
import path from "node:path";
import { resolveStoragePath } from "../assets/assetStorage";
import { logger } from "../logger";
import { config } from "../config";

export type BackupLimitOptions = {
  maxCount?: number;
  maxTotalBytes?: number;
  minFreeDiskPercent?: number;
};

export type BackupPolicy = {
  maxCount: number;
  maxTotalBytes: number;
  minFreeDiskPercent: number;
};

const resolvePolicy = (options: BackupLimitOptions): BackupPolicy => ({
  maxCount: options.maxCount ?? config.backups.maxCount,
  maxTotalBytes: options.maxTotalBytes ?? config.backups.maxTotalBytes,
  minFreeDiskPercent: options.minFreeDiskPercent ?? config.backups.minFreeDiskPercent,
});

type BackupFile = { path: string; bytes: number; mtimeMs: number; name: string };

const completedBackups = async (backupDir: string): Promise<BackupFile[]> => {
  const entries = await fs.promises.readdir(backupDir, { withFileTypes: true });
  const backups = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && /^excalidash-(?:sqlite-.*\.db|backup-.*\.zip)$/.test(entry.name),
      )
      .map(async (entry) => {
        const filePath = path.join(backupDir, entry.name);
        const info = await fs.promises.stat(filePath);
        return { path: filePath, bytes: info.size, mtimeMs: info.mtimeMs, name: entry.name };
      }),
  );
  return backups.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
  );
};

export const enforceBackupLimits = async (
  backupDir: string,
  maxCount: number,
  maxTotalBytes: number,
  minCount = 0,
): Promise<void> => {
  const backups = await completedBackups(backupDir);
  let bytes = backups.reduce((sum, backup) => sum + backup.bytes, 0);
  while ((backups.length > maxCount || bytes > maxTotalBytes) && backups.length > minCount) {
    const oldest = backups.shift();
    if (!oldest) break;
    await fs.promises.unlink(oldest.path);
    bytes -= oldest.bytes;
    logger.info("backup pruned to enforce count/byte limits", { name: oldest.name });
  }
};

const directoryUsage = async (root: string): Promise<{ bytes: number; files: number }> => {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return { bytes: 0, files: 0 };
    throw error;
  }

  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryUsage(entryPath);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      const info = await fs.promises.stat(entryPath);
      bytes += info.size;
      files += 1;
    }
  }
  return { bytes, files };
};

const estimateArchiveBytes = async (
  databasePath: string,
  assetStorageDir: string,
): Promise<{ archiveBytes: number; workingBytes: number }> => {
  const databaseBytes = (await fs.promises.stat(databasePath)).size;
  const originalsRoot = resolveStoragePath(assetStorageDir, "originals");
  const originals = await directoryUsage(originalsRoot);
  const rawBytes = databaseBytes + originals.bytes;
  // ZIP headers and incompressible streams can be slightly larger than their
  // input. The copy of SQLite exists beside the partial archive while writing.
  const archiveBytes = Math.ceil(rawBytes * 1.02) + (originals.files + 4) * 1024 + 1024 * 1024;
  return { archiveBytes, workingBytes: databaseBytes + archiveBytes };
};

const assertDiskHeadroom = async (
  backupDir: string,
  workingBytes: number,
  minFreeDiskPercent: number,
): Promise<void> => {
  const disk = await fs.promises.statfs(backupDir);
  const total = Number(disk.blocks) * Number(disk.bsize);
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (!total) return;
  const reserve = (total * minFreeDiskPercent) / 100;
  if (available - workingBytes < reserve) {
    const availableMb = Math.floor(available / 1024 / 1024);
    const neededMb = Math.ceil((workingBytes + reserve) / 1024 / 1024);
    throw new Error(
      `[backup] Refusing to start: ${availableMb} MiB available, at least ${neededMb} MiB needed ` +
        `to preserve BACKUP_MIN_FREE_DISK_PERCENT=${minFreeDiskPercent}.`,
    );
  }
};

export const prepareBackupSpace = async ({
  backupDir,
  databasePath,
  assetStorageDir,
  ...overrides
}: BackupLimitOptions & {
  backupDir: string;
  databasePath: string;
  assetStorageDir: string;
}): Promise<BackupPolicy> => {
  const policy = resolvePolicy(overrides);
  const estimate = await estimateArchiveBytes(databasePath, assetStorageDir);
  if (estimate.archiveBytes > policy.maxTotalBytes) {
    throw new Error(
      `[backup] Refusing to start: estimated archive is ${Math.ceil(estimate.archiveBytes / 1024 / 1024)} MiB, ` +
        `larger than BACKUP_MAX_TOTAL_MB=${Math.floor(policy.maxTotalBytes / 1024 / 1024)}.`,
    );
  }
  await enforceBackupLimits(
    backupDir,
    Math.max(1, policy.maxCount - 1),
    Math.max(0, policy.maxTotalBytes - estimate.archiveBytes),
    1,
  );
  await assertDiskHeadroom(backupDir, estimate.workingBytes, policy.minFreeDiskPercent);
  return policy;
};
