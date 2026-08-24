/**
 * Runs the real SQLite migration SQL from
 * `prisma/migrations/sqlite/20260824130800_add_nil381_drawing_files/`
 * against a throwaway in-memory database (NIL-381/NIL-503).
 *
 * What this proves: DrawingFile's foreign keys are actually enforced (a
 * reference to a nonexistent drawing or blob is rejected, not merely
 * declared), the composite (drawingId, fileId) primary key rejects a
 * duplicate binding, and deleting the drawing or the blob cascades/blocks
 * the way ownership of an image's bytes is supposed to work.
 */
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET_MIGRATION = "20260824130800_add_nil381_drawing_files";

describe("NIL-381 sqlite migration: DrawingFile", () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  const seedPreMigrationDb = (): Database.Database => {
    const handle = createInMemorySqliteDb();
    applySqliteMigrationsBefore(handle, TARGET_MIGRATION);

    handle
      .prepare(
        `INSERT INTO "User" (id, email, passwordHash, name, role, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run("u1", "a@example.com", "x", "Alice", "USER");

    handle
      .prepare(
        `INSERT INTO "Drawing" (id, name, elements, appState, userId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run("d1", "Board One", "[]", "{}", "u1");

    handle
      .prepare(
        `INSERT INTO "StoredBlob" (id, sha256, sizeBytes, storedBytes, storageKey, purpose, state, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run("blob1", "a".repeat(64), 1024, 1024, "originals/aa/bb/blob1", "IMAGE", "READY");

    return handle;
  };

  it("accepts a DrawingFile row referencing an existing drawing and blob", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    db.prepare(
      `INSERT INTO "DrawingFile" (drawingId, fileId, blobId, ownerUserId, mimeType, createdAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("d1", "file1", "blob1", "u1", "image/png");

    const row = db
      .prepare(
        `SELECT blobId, ownerUserId, mimeType FROM "DrawingFile" WHERE drawingId = ? AND fileId = ?`,
      )
      .get("d1", "file1") as { blobId: string; ownerUserId: string; mimeType: string };

    expect(row.blobId).toBe("blob1");
    expect(row.ownerUserId).toBe("u1");
    expect(row.mimeType).toBe("image/png");
  });

  it("enforces the drawingId foreign key -- a file cannot bind to a drawing that does not exist", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    expect(() =>
      db!
        .prepare(
          `INSERT INTO "DrawingFile" (drawingId, fileId, blobId, ownerUserId, mimeType, createdAt)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run("does-not-exist", "file1", "blob1", "u1", "image/png"),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces the blobId foreign key -- a file cannot reference bytes that do not exist", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    expect(() =>
      db!
        .prepare(
          `INSERT INTO "DrawingFile" (drawingId, fileId, blobId, ownerUserId, mimeType, createdAt)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run("d1", "file1", "does-not-exist", "u1", "image/png"),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("rejects a duplicate (drawingId, fileId) binding", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    db.prepare(
      `INSERT INTO "DrawingFile" (drawingId, fileId, blobId, ownerUserId, mimeType, createdAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("d1", "file1", "blob1", "u1", "image/png");

    expect(() =>
      db!
        .prepare(
          `INSERT INTO "DrawingFile" (drawingId, fileId, blobId, ownerUserId, mimeType, createdAt)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run("d1", "file1", "blob1", "u1", "image/png"),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it("cascades: deleting the drawing deletes its file references", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    db.prepare(
      `INSERT INTO "DrawingFile" (drawingId, fileId, blobId, ownerUserId, mimeType, createdAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("d1", "file1", "blob1", "u1", "image/png");

    db.prepare(`DELETE FROM "Drawing" WHERE id = ?`).run("d1");

    const remaining = db
      .prepare(`SELECT drawingId FROM "DrawingFile" WHERE drawingId = ?`)
      .get("d1");
    expect(remaining).toBeUndefined();
  });

  it("restricts: deleting a blob still referenced by a DrawingFile row is blocked", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    db.prepare(
      `INSERT INTO "DrawingFile" (drawingId, fileId, blobId, ownerUserId, mimeType, createdAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("d1", "file1", "blob1", "u1", "image/png");

    expect(() => db!.prepare(`DELETE FROM "StoredBlob" WHERE id = ?`).run("blob1")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
