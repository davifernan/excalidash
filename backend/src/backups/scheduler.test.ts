import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import {
  cleanupExpiredAuthData,
  createDatabaseBackup,
  startScheduledMaintenance,
} from "./scheduler";

const Database = require("better-sqlite3") as any;
const tempDirs: string[] = [];

const buildPrisma = () => ({
  refreshToken: { deleteMany: vi.fn().mockResolvedValue({ count: 4 }) },
  passwordResetToken: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
  auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 7 }) },
});

const authCleanupRunsAt = async (schedule: string, tickAt: Date): Promise<number> => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(tickAt.getTime() - 1000));
  const prisma = buildPrisma();
  const stop = startScheduledMaintenance({
    backups: {
      prisma: prisma as any,
      databaseUrl: undefined,
      schedule: null,
      backupDir: "/not-used",
      assetStorageDir: "/not-used",
      retentionDays: 14,
    },
    authCleanup: {
      prisma: prisma as any,
      schedule,
      tokenRetentionDays: 30,
      auditRetentionDays: 365,
    },
  });

  try {
    await vi.advanceTimersByTimeAsync(1000);
    return prisma.refreshToken.deleteMany.mock.calls.length;
  } finally {
    stop?.();
  }
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("scheduled backups", () => {
  it("archives the SQLite copy and referenced originals without the cache", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "scheduled-backup-"));
    tempDirs.push(root);
    const databasePath = join(root, "source.db");
    const backupDir = join(root, "backups");
    const assetStorageDir = join(root, "assets");
    const storageKey = "originals/ab/cd/blob-id";
    const original = Buffer.from("original bytes");
    await fs.mkdir(join(assetStorageDir, "originals/ab/cd"), { recursive: true });
    await fs.mkdir(join(assetStorageDir, "cache/asset"), { recursive: true });
    await fs.writeFile(join(assetStorageDir, storageKey), original);
    await fs.writeFile(join(root, ".jwt_secret"), "jwt-secret");
    await fs.writeFile(join(root, ".csrf_secret"), "csrf-secret");
    await fs.writeFile(join(assetStorageDir, "cache/asset/page.svg"), "discard me");
    await fs.mkdir(backupDir);
    const expiredBackup = join(backupDir, "excalidash-sqlite-expired.db");
    const stalePartial = join(backupDir, ".excalidash-stale.sqlite.part");
    await fs.writeFile(expiredBackup, "old");
    await fs.writeFile(stalePartial, "interrupted");
    const oldBackupTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const oldPartialTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(expiredBackup, oldBackupTime, oldBackupTime);
    await fs.utimes(stalePartial, oldPartialTime, oldPartialTime);
    const db = new Database(databasePath);
    db.exec('CREATE TABLE "StoredBlob" ("storageKey" TEXT NOT NULL, "state" TEXT NOT NULL)');
    db.prepare('INSERT INTO "StoredBlob" ("storageKey", "state") VALUES (?, ?)').run(
      storageKey,
      "READY",
    );
    db.close();

    const target = await createDatabaseBackup({
      // The checkpoint goes through queryRaw because the PRAGMA answers with a
      // row; a stub without it hides that the real client would refuse.
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as any,
      databaseUrl: `file:${databasePath}`,
      provider: "sqlite",
      secretsDir: dirname(databasePath),
      pgDumpPath: "pg_dump",
      backupDir,
      assetStorageDir,
      retentionDays: 14,
    });
    const archive = await JSZip.loadAsync(await fs.readFile(target!));
    expect(archive.file("database.sqlite")).toBeTruthy();
    expect(await archive.file(`assets/${storageKey}`)!.async("nodebuffer")).toEqual(original);
    expect(await archive.file("secrets/.jwt_secret")!.async("string")).toBe("jwt-secret");
    expect(await archive.file("secrets/.csrf_secret")!.async("string")).toBe("csrf-secret");
    expect(Object.keys(archive.files).some((name) => name.includes("/cache/"))).toBe(false);
    await expect(fs.stat(expiredBackup)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stalePartial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no WAL sidecar files behind when the source database uses WAL mode", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "scheduled-backup-wal-"));
    tempDirs.push(root);
    const databasePath = join(root, "source.db");
    const backupDir = join(root, "backups");
    const assetStorageDir = join(root, "assets");
    await fs.mkdir(backupDir);
    await fs.mkdir(join(assetStorageDir, "originals"), { recursive: true });

    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.exec('CREATE TABLE "StoredBlob" ("storageKey" TEXT NOT NULL, "state" TEXT NOT NULL)');
    // Enough rows to grow a real WAL. A database left in rollback mode copies
    // without sidecars, and the test would then measure nothing.
    const insert = db.prepare('INSERT INTO "StoredBlob" ("storageKey", "state") VALUES (?, ?)');
    for (let index = 0; index < 500; index += 1) {
      insert.run(`originals/ab/cd/blob-${index}`, "PENDING");
    }
    db.close();

    const target = await createDatabaseBackup({
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as any,
      databaseUrl: `file:${databasePath}`,
      provider: "sqlite",
      secretsDir: dirname(databasePath),
      pgDumpPath: "pg_dump",
      backupDir,
      assetStorageDir,
      retentionDays: 14,
    });

    expect(target).toBeTruthy();
    // The working copy is opened read-only to read its blob table, and a
    // read-only connection can neither checkpoint nor unlink the -shm/-wal it
    // creates. Removing only the `.part` leaves both behind for good.
    const leftovers = (await fs.readdir(backupDir)).filter((name) => !name.endsWith(".zip"));
    expect(leftovers).toEqual([]);
  });

  it("prunes WAL sidecars stranded by earlier backup runs", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "scheduled-backup-sidecar-prune-"));
    tempDirs.push(root);
    const databasePath = join(root, "source.db");
    const backupDir = join(root, "backups");
    const assetStorageDir = join(root, "assets");
    await fs.mkdir(backupDir);
    await fs.mkdir(join(assetStorageDir, "originals"), { recursive: true });

    const strandedShm = join(backupDir, ".excalidash-2026-08-23T09-46-28-913Z-350.sqlite.part-shm");
    const strandedWal = join(backupDir, ".excalidash-2026-08-23T09-46-28-913Z-350.sqlite.part-wal");
    await fs.writeFile(strandedShm, "shared memory index");
    await fs.writeFile(strandedWal, "");
    const strandedTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(strandedShm, strandedTime, strandedTime);
    await fs.utimes(strandedWal, strandedTime, strandedTime);

    const db = new Database(databasePath);
    db.exec('CREATE TABLE "StoredBlob" ("storageKey" TEXT NOT NULL, "state" TEXT NOT NULL)');
    db.close();

    await createDatabaseBackup({
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as any,
      databaseUrl: `file:${databasePath}`,
      provider: "sqlite",
      secretsDir: dirname(databasePath),
      pgDumpPath: "pg_dump",
      backupDir,
      assetStorageDir,
      retentionDays: 14,
    });

    await expect(fs.stat(strandedShm)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(strandedWal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps no more than the configured number of completed backups", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "scheduled-backup-count-"));
    tempDirs.push(root);
    const databasePath = join(root, "source.db");
    const backupDir = join(root, "backups");
    const assetStorageDir = join(root, "assets");
    await fs.mkdir(backupDir);
    await fs.mkdir(assetStorageDir);
    const db = new Database(databasePath);
    db.exec('CREATE TABLE "StoredBlob" ("storageKey" TEXT NOT NULL, "state" TEXT NOT NULL)');
    db.close();
    for (let index = 0; index < 3; index += 1) {
      const name = `excalidash-backup-2026-08-${10 + index}T00-00-00-000Z.zip`;
      await fs.writeFile(join(backupDir, name), Buffer.alloc(64, index));
      const when = new Date(`2026-08-${10 + index}T00:00:00.000Z`);
      await fs.utimes(join(backupDir, name), when, when);
    }

    await createDatabaseBackup({
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as any,
      databaseUrl: `file:${databasePath}`,
      provider: "sqlite",
      secretsDir: dirname(databasePath),
      pgDumpPath: "pg_dump",
      backupDir,
      assetStorageDir,
      retentionDays: 365,
      maxCount: 2,
      maxTotalBytes: 20 * 1024 * 1024,
      minFreeDiskPercent: 0,
    });

    const completed = (await fs.readdir(backupDir)).filter((name) => name.endsWith(".zip"));
    expect(completed).toHaveLength(2);
  });

  it("aborts clearly before writing when one backup exceeds the byte budget", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "scheduled-backup-budget-"));
    tempDirs.push(root);
    const databasePath = join(root, "source.db");
    const backupDir = join(root, "backups");
    const assetStorageDir = join(root, "assets");
    await fs.mkdir(backupDir);
    await fs.mkdir(assetStorageDir);
    const db = new Database(databasePath);
    db.exec('CREATE TABLE "StoredBlob" ("storageKey" TEXT NOT NULL, "state" TEXT NOT NULL)');
    db.close();

    await expect(
      createDatabaseBackup({
        prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as any,
        databaseUrl: `file:${databasePath}`,
        provider: "sqlite",
        secretsDir: dirname(databasePath),
        pgDumpPath: "pg_dump",
        backupDir,
        assetStorageDir,
        retentionDays: 14,
        maxCount: 7,
        maxTotalBytes: 1,
        minFreeDiskPercent: 0,
      }),
    ).rejects.toThrow(/BACKUP_MAX_TOTAL_MB/);

    expect((await fs.readdir(backupDir)).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("aborts before its working files would cross the free-space floor", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "scheduled-backup-headroom-"));
    tempDirs.push(root);
    const databasePath = join(root, "source.db");
    const backupDir = join(root, "backups");
    const assetStorageDir = join(root, "assets");
    await fs.mkdir(backupDir);
    await fs.mkdir(assetStorageDir);
    const db = new Database(databasePath);
    db.exec('CREATE TABLE "StoredBlob" ("storageKey" TEXT NOT NULL, "state" TEXT NOT NULL)');
    db.close();

    await expect(
      createDatabaseBackup({
        prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as any,
        databaseUrl: `file:${databasePath}`,
        provider: "sqlite",
        secretsDir: dirname(databasePath),
        pgDumpPath: "pg_dump",
        backupDir,
        assetStorageDir,
        retentionDays: 14,
        maxCount: 7,
        maxTotalBytes: 20 * 1024 * 1024,
        minFreeDiskPercent: 100,
      }),
    ).rejects.toThrow(/BACKUP_MIN_FREE_DISK_PERCENT=100/);

    expect((await fs.readdir(backupDir)).some((name) => name.endsWith(".part"))).toBe(false);
  });
});

describe("auth data retention", () => {
  it("keeps live and recent security records outside the delete filters", async () => {
    const prisma = buildPrisma();
    const now = new Date("2026-08-20T03:00:00.000Z");

    const counts = await cleanupExpiredAuthData({
      prisma: prisma as any,
      tokenRetentionDays: 30,
      auditRetentionDays: 365,
      now,
    });

    const tokenCutoff = new Date("2026-07-21T03:00:00.000Z");
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: tokenCutoff },
        OR: [{ revoked: true }, { expiresAt: { lt: now } }],
      },
    });
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: tokenCutoff },
        OR: [{ used: true }, { expiresAt: { lt: now } }],
      },
    });
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2025-08-20T03:00:00.000Z") } },
    });
    expect(counts).toEqual({ refreshTokens: 4, passwordResetTokens: 2, auditLogs: 7 });
  });

  it("runs cleanup through the shared maintenance scheduler without backups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T03:00:00.000Z"));
    const prisma = buildPrisma();
    const stop = startScheduledMaintenance({
      backups: {
        prisma: prisma as any,
        databaseUrl: undefined,
        schedule: null,
        backupDir: "/not-used",
        assetStorageDir: "/not-used",
        retentionDays: 14,
      },
      authCleanup: {
        prisma: prisma as any,
        schedule: "* * * * * *",
        tokenRetentionDays: 30,
        auditRetentionDays: 365,
      },
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(stop).toEqual(expect.any(Function));
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledTimes(1);
    stop?.();
  });
});

describe("maintenance cron day fields", () => {
  it("runs when the month day matches but the restricted week day does not", async () => {
    const thursdayFirst = new Date(2024, 7, 1, 3, 0, 0);

    await expect(authCleanupRunsAt("0 0 3 1 * 1", thursdayFirst)).resolves.toBe(1);
  });

  it("runs when the week day matches but the restricted month day does not", async () => {
    const mondayEighth = new Date(2024, 6, 8, 3, 0, 0);

    await expect(authCleanupRunsAt("0 0 3 1 * 1", mondayEighth)).resolves.toBe(1);
  });

  it("does not run when neither restricted day field matches", async () => {
    const tuesdayNinth = new Date(2024, 6, 9, 3, 0, 0);

    await expect(authCleanupRunsAt("0 0 3 1 * 1", tuesdayNinth)).resolves.toBe(0);
  });

  it("keeps a lone month-day restriction and both wildcards unchanged", async () => {
    const thursdayFirst = new Date(2024, 7, 1, 3, 0, 0);
    const mondayEighth = new Date(2024, 6, 8, 3, 0, 0);

    await expect(authCleanupRunsAt("0 0 3 1 * *", thursdayFirst)).resolves.toBe(1);
    await expect(authCleanupRunsAt("0 0 3 1 * *", mondayEighth)).resolves.toBe(0);
    await expect(authCleanupRunsAt("0 0 3 * * *", mondayEighth)).resolves.toBe(1);
  });

  it("keeps a lone week-day restriction unchanged", async () => {
    const thursdayFirst = new Date(2024, 7, 1, 3, 0, 0);
    const mondayEighth = new Date(2024, 6, 8, 3, 0, 0);

    await expect(authCleanupRunsAt("0 0 3 * * 1", mondayEighth)).resolves.toBe(1);
    await expect(authCleanupRunsAt("0 0 3 * * 1", thursdayFirst)).resolves.toBe(0);
  });
});
