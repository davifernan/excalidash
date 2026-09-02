/**
 * Proves the one thing a backup exists for: that the archive can be turned
 * back into the board it came from.
 *
 * Everything else about backups was already asserted -- that a ZIP appears,
 * that it holds a file of the expected name, that the render cache stays out.
 * None of that establishes the archive is *restorable*; a truncated dump or a
 * snapshot taken with the wrong flags satisfies every one of those checks. So
 * this test does what an operator does: it extracts the database out of the
 * archive and reads the board back through a fresh connection, without the
 * application in the loop.
 *
 * Runs under both providers, each restoring the way its own runbook does
 * (docs/RESTORE.md): `pg_restore` into an empty database for PostgreSQL, a
 * direct read of the copied file for SQLite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  getTestPrisma,
  setupTestDb,
  testDatabaseProvider,
  testDatabaseUrl,
} from "../__tests__/testUtils";
import { createDatabaseBackup } from "./scheduler";
import { pgDumpEnvironment } from "./scheduler";

const BOARD_NAME = "Restore proof board";

const pgEnvironment = () => {
  const { env, schema } = pgDumpEnvironment(testDatabaseUrl);
  if (!schema) throw new Error("The test connection URL is expected to carry a schema");
  return { env, schema };
};

describe("backup archives restore to the board they came from", () => {
  const prisma = getTestPrisma();
  let root: string;
  let assetStorageDir: string;
  let backupDir: string;

  beforeEach(async () => {
    await setupTestDb();
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "restore-proof-"));
    assetStorageDir = path.join(root, "assets");
    backupDir = path.join(root, "backups");
    await fs.promises.mkdir(path.join(assetStorageDir, "originals"), { recursive: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("recovers the board from the archived database, provider's own way", async () => {
    const user = await createTestUser(prisma, "restore-proof@example.com");
    await prisma.drawing.create({
      data: { name: BOARD_NAME, elements: "[]", appState: "{}", userId: user.id },
    });

    const target = await createDatabaseBackup({
      prisma,
      provider: testDatabaseProvider,
      databaseUrl: testDatabaseUrl,
      backupDir,
      assetStorageDir,
      secretsDir: path.join(root, "secrets"),
      pgDumpPath: process.env.BACKUP_PG_DUMP_PATH || "pg_dump",
      retentionDays: 14,
    });

    const archive = await JSZip.loadAsync(await fs.promises.readFile(target));
    const manifest = JSON.parse(await archive.file("backup.manifest.json")!.async("string"));
    expect(manifest.databaseProvider).toBe(testDatabaseProvider);

    const snapshotPath = path.join(root, manifest.database);
    await fs.promises.writeFile(
      snapshotPath,
      await archive.file(manifest.database)!.async("nodebuffer"),
    );

    // The board must be gone from the live database before the restore is
    // asked to produce it. Otherwise a restore that silently did nothing would
    // still find the row and the test would pass on the wrong evidence.
    await prisma.drawing.deleteMany({});
    expect(await prisma.drawing.count()).toBe(0);

    if (testDatabaseProvider === "postgresql") {
      const { env, schema } = pgEnvironment();
      const restoreDb = `restore_proof_${schema}`;
      const admin = { ...env, PGDATABASE: "postgres" };
      execFileSync(
        "psql",
        ["-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${restoreDb}`],
        {
          env: admin,
          stdio: "ignore",
        },
      );
      execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${restoreDb}`], {
        env: admin,
        stdio: "ignore",
      });
      try {
        execFileSync("pg_restore", ["--no-owner", "--dbname", restoreDb, snapshotPath], {
          env,
          stdio: "pipe",
        });
        const names = execFileSync("psql", ["-tAc", `SELECT "name" FROM ${schema}."Drawing"`], {
          env: { ...env, PGDATABASE: restoreDb },
          encoding: "utf8",
        }).trim();
        expect(names).toBe(BOARD_NAME);
      } finally {
        execFileSync("psql", ["-c", `DROP DATABASE IF EXISTS ${restoreDb}`], {
          env: admin,
          stdio: "ignore",
        });
      }
    } else {
      const Database = require("better-sqlite3") as any;
      const restored = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        const rows = restored.prepare('SELECT "name" FROM "Drawing"').all() as Array<{
          name: string;
        }>;
        expect(rows.map((row) => row.name)).toEqual([BOARD_NAME]);
      } finally {
        restored.close();
      }
    }
  });
});
