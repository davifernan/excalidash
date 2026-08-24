/**
 * Runs the real SQLite migration SQL from
 * `prisma/migrations/sqlite/20260824012055_add_nil326_discovery_library_lifecycle/`
 * against a throwaway in-memory database -- not a description of what the
 * SQL is supposed to do, the actual SQL, executed. No migration in this
 * repo had a test doing that before this file (Hans-Friedrich, PR #66):
 * `provider-prisma.test.ts` only checks that migration folders exist, never
 * that the SQL inside one behaves as its own comment claims.
 *
 * Postgres coverage: not automated here. The migration's postgresql
 * sibling backfills the corrupt-row fallback inside a `DO $$ ... EXCEPTION
 * ... END $$` block -- a construct neither `pg-mem` nor any other
 * in-process Postgres emulator reliably executes (exception handling in a
 * PL/pgSQL anonymous block is exactly the kind of thing an emulator
 * approximates, not implements), so a test built on one would not actually
 * exercise the real behavior; it would just be confidence with a different
 * shape than the sqlite gap it's meant to catch. A real Postgres CI service
 * container is the honest way to cover it and does not exist in this
 * repo's CI today. The postgresql migration WAS verified manually,
 * end-to-end, against a throwaway `postgres:16-alpine` container (see the
 * PR's HANDOFF) -- that is real evidence, but it is not CI coverage, and
 * this comment names that gap rather than implying the test below closes
 * it for both dialects.
 */
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET_MIGRATION = "20260824012055_add_nil326_discovery_library_lifecycle";

describe("NIL-326 sqlite migration: Drawing.searchText backfill", () => {
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
      .run(
        "d-valid",
        "Roadmap Q3",
        JSON.stringify([{ type: "text", text: "Ship the roadmap", isDeleted: false }]),
        "{}",
        "u1",
      );

    handle
      .prepare(
        `INSERT INTO "Drawing" (id, name, elements, appState, userId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run("d-corrupt", "Legacy Board With Corrupt Elements", "not-valid-json", "{}", "u1");

    return handle;
  };

  it("leaves a board with corrupt elements JSON name-only searchable, not empty", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    const corrupt = db
      .prepare(`SELECT name, searchText FROM "Drawing" WHERE id = ?`)
      .get("d-corrupt") as { name: string; searchText: string };

    // The exact claim the migration's own comment makes: name-only
    // searchable, not the column default.
    expect(corrupt.searchText).toBe(corrupt.name.toLowerCase());
    expect(corrupt.searchText).not.toBe("");
  });

  it("still computes full name + content search text for a board with valid elements", () => {
    db = seedPreMigrationDb();
    applySqliteMigration(db, TARGET_MIGRATION);

    const valid = db.prepare(`SELECT searchText FROM "Drawing" WHERE id = ?`).get("d-valid") as {
      searchText: string;
    };

    expect(valid.searchText).toBe("roadmap q3 ship the roadmap");
  });
});
