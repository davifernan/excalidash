import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDatabaseWritable,
  registerOperationalHealthRoutes,
  type DatabaseWriteClient,
} from "./operationalHealth";

const Database = require("better-sqlite3") as any;

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const makeApp = (
  overrides: Partial<Parameters<typeof registerOperationalHealthRoutes>[1]> = {},
) => {
  const app = express();
  const database = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  } satisfies DatabaseWriteClient;
  const readFreeDiskPercent = vi.fn().mockResolvedValue(55);
  registerOperationalHealthRoutes(app, {
    database,
    diskPath: "/data",
    minFreeDiskPercent: 20,
    backupSchedule: null,
    backupDir: "/backups",
    backupMaxAgeMs: 48 * 60 * 60 * 1000,
    cacheTtlMs: 30_000,
    readFreeDiskPercent,
    now: () => Date.parse("2026-08-22T12:00:00.000Z"),
    ...overrides,
  });
  return { app, database, readFreeDiskPercent };
};

describe("operational health endpoints", () => {
  it("keeps process liveness cheap and independent of readiness probes", async () => {
    const { app, database, readFreeDiskPercent } = makeApp();

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(database.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(readFreeDiskPercent).not.toHaveBeenCalled();
  });

  it("reports healthy writable storage and exposes cache age", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let now = Date.parse("2026-08-22T12:00:00.000Z");
    const { app, database } = makeApp({ now: () => now });

    const first = await request(app).get("/ready");
    now += 1_500;
    const cached = await request(app).get("/ready");

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: "ok",
      checkedAt: "2026-08-22T12:00:00.000Z",
      cache: { ttlMs: 30_000, ageMs: 0 },
      checks: {
        database: { status: "ok", writable: true },
        disk: { status: "ok", freePercent: 55, minimumFreePercent: 20 },
        backup: { status: "disabled", scheduled: false },
      },
    });
    expect(cached.body.cache.ageMs).toBe(1_500);
    expect(database.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(
      'UPDATE "SystemConfig" SET "id" = "id" WHERE 1 = 0',
    );
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it("returns 503 when the database writer path is unavailable", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failure = new Error("attempt to write a readonly database");
    const database = {
      $executeRawUnsafe: vi.fn().mockRejectedValue(failure),
    } satisfies DatabaseWriteClient;
    const { app } = makeApp({ database });

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.status).toBe("error");
    expect(response.body.checks.database).toEqual({ status: "error", writable: false });
    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(stderrWrite.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      level: "error",
      message: "Readiness database check failed",
      error: expect.objectContaining({ message: "attempt to write a readonly database" }),
    });
  });

  it("uses a real SQLite write statement that fails on a read-only connection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "readiness-readonly-"));
    tempDirs.push(root);
    const databasePath = path.join(root, "health.db");
    const writable = new Database(databasePath);
    writable.exec('CREATE TABLE "SystemConfig" ("id" TEXT PRIMARY KEY)');
    writable.close();
    const readOnly = new Database(databasePath, { readonly: true, fileMustExist: true });
    const database = {
      $executeRawUnsafe: (query: string) => Promise.resolve().then(() => readOnly.exec(query)),
    } satisfies DatabaseWriteClient;

    try {
      await expect(assertDatabaseWritable(database)).rejects.toThrow(/readonly/i);
    } finally {
      readOnly.close();
    }
  });

  it("returns 503 when free disk is below the operating floor", async () => {
    const { app } = makeApp({ readFreeDiskPercent: vi.fn().mockResolvedValue(4.94) });

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.checks.disk).toEqual({
      status: "critical",
      freePercent: 4.9,
      minimumFreePercent: 20,
    });
  });

  it("uses the reported one-decimal disk percentage for the operating floor", async () => {
    const { app } = makeApp({ readFreeDiskPercent: vi.fn().mockResolvedValue(19.96) });

    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.checks.disk).toEqual({
      status: "ok",
      freePercent: 20,
      minimumFreePercent: 20,
    });
  });

  it("reports a stale completed backup as a warning without failing readiness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "readiness-backup-"));
    tempDirs.push(root);
    const backupPath = path.join(root, "excalidash-backup-2026-08-20T11-00-00-000Z.zip");
    await fs.writeFile(backupPath, "complete");
    const old = new Date("2026-08-20T11:00:00.000Z");
    await fs.utimes(backupPath, old, old);
    const { app } = makeApp({
      backupSchedule: "0 0 3 * * *",
      backupDir: root,
    });

    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("warning");
    expect(response.body.checks.backup).toEqual({
      status: "stale",
      scheduled: true,
      latestSuccessfulAt: "2026-08-20T11:00:00.000Z",
      ageSeconds: 49 * 60 * 60,
      maximumAgeSeconds: 48 * 60 * 60,
    });
  });

  it("does not count partial archives as successful backups", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "readiness-partial-"));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, "excalidash-backup-interrupted.zip.part"), "partial");
    const { app } = makeApp({
      backupSchedule: "0 0 3 * * *",
      backupDir: root,
    });

    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("warning");
    expect(response.body.checks.backup.status).toBe("missing");
  });
});
