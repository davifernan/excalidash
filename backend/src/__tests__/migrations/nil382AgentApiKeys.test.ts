/**
 * Runs the real SQLite migration SQL from
 * `prisma/migrations/sqlite/20260824120000_add_nil382_agent_tokens/`
 * against a throwaway in-memory database (NIL-382/NIL-503).
 *
 * What this proves, concretely: an `ApiKey` row created before this
 * migration keeps `drawingId`/`expiresAt` NULL after the table rebuild
 * (SQLite has no `ALTER TABLE ADD COLUMN` with a foreign key in one step,
 * so Prisma's sqlite migrator always does a full RedefineTables copy --
 * the exact operation a NIL-326-style backfill divergence hides inside),
 * and that the new `drawingId` foreign key is actually enforced once the
 * migration re-enables `PRAGMA foreign_keys`, not merely declared.
 */
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET_MIGRATION = "20260824120000_add_nil382_agent_tokens";

describe("NIL-382 sqlite migration: ApiKey.drawingId / ApiKey.expiresAt", () => {
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

    // A pre-existing account-wide key -- the row this migration must not disturb.
    handle
      .prepare(
        `INSERT INTO "ApiKey" (id, userId, name, keyId, tokenHash, prefix, scopes, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        "key-preexisting",
        "u1",
        "Old account key",
        "keyid-old",
        "hash-old",
        "exd_old",
        "drawings:read,drawings:write,collections:read,collections:write",
      );

    return handle;
  };

  it("leaves a pre-existing account-wide key's new columns NULL", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    const row = db
      .prepare(`SELECT drawingId, expiresAt, scopes, tokenHash FROM "ApiKey" WHERE id = ?`)
      .get("key-preexisting") as {
      drawingId: string | null;
      expiresAt: string | null;
      scopes: string;
      tokenHash: string;
    };

    expect(row.drawingId).toBeNull();
    expect(row.expiresAt).toBeNull();
    // The table rebuild must not have touched the surviving columns' data.
    expect(row.scopes).toBe("drawings:read,drawings:write,collections:read,collections:write");
    expect(row.tokenHash).toBe("hash-old");
  });

  it("accepts a new agent key bound to an existing drawing", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    db.prepare(
      `INSERT INTO "ApiKey"
         (id, userId, name, keyId, tokenHash, prefix, scopes, drawingId, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      "key-agent",
      "u1",
      "Agent token",
      "keyid-agent",
      "hash-agent",
      "exd_age",
      "drawing:read,drawing:ops",
      "d1",
      "2026-09-23 00:00:00",
    );

    const row = db
      .prepare(`SELECT drawingId, expiresAt FROM "ApiKey" WHERE id = ?`)
      .get("key-agent") as { drawingId: string; expiresAt: string };

    expect(row.drawingId).toBe("d1");
    expect(row.expiresAt).toBe("2026-09-23 00:00:00");
  });

  it("enforces the drawingId foreign key -- a key cannot bind to a drawing that does not exist", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    expect(() =>
      db!
        .prepare(
          `INSERT INTO "ApiKey"
             (id, userId, name, keyId, tokenHash, prefix, scopes, drawingId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .run(
          "key-orphan",
          "u1",
          "Orphan agent token",
          "keyid-orphan",
          "hash-orphan",
          "exd_orp",
          "drawing:read",
          "does-not-exist",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("cascades: deleting the bound drawing deletes its agent key", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    db.prepare(
      `INSERT INTO "ApiKey"
         (id, userId, name, keyId, tokenHash, prefix, scopes, drawingId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      "key-agent",
      "u1",
      "Agent token",
      "keyid-agent",
      "hash-agent",
      "exd_age",
      "drawing:read",
      "d1",
    );

    db.prepare(`DELETE FROM "Drawing" WHERE id = ?`).run("d1");

    const remaining = db.prepare(`SELECT id FROM "ApiKey" WHERE id = ?`).get("key-agent");
    expect(remaining).toBeUndefined();
  });
});
