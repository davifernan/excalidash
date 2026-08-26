import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET_MIGRATION = "20260826163000_add_guest_capabilities";

describe("NIL-615 guest capability migration", () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("preserves the two different historical behaviors for existing and new rows", () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET_MIGRATION);
    db.prepare(
      `INSERT INTO "User" (id, email, passwordHash, name, role, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run("u1", "owner@example.com", "hash", "Owner", "USER");
    db.prepare(
      `INSERT INTO "Drawing" (id, name, elements, appState, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run("d1", "Existing", "[]", "{}", "u1");

    applySqliteMigration(db, TARGET_MIGRATION);

    const instance = db
      .prepare(
        `SELECT guestUploadEnabled, guestCommentVisibilityEnabled
         FROM "SystemConfig" WHERE id = 'default'`,
      )
      .get() as { guestUploadEnabled: number; guestCommentVisibilityEnabled: number };
    const existing = db
      .prepare(
        `SELECT guestUploadEnabled, guestCommentVisibilityEnabled FROM "Drawing" WHERE id = 'd1'`,
      )
      .get() as { guestUploadEnabled: number; guestCommentVisibilityEnabled: number };
    expect(instance).toEqual({ guestUploadEnabled: 0, guestCommentVisibilityEnabled: 1 });
    expect(existing).toEqual({ guestUploadEnabled: 0, guestCommentVisibilityEnabled: 1 });

    db.prepare(
      `INSERT INTO "Drawing" (id, name, elements, appState, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run("d2", "New", "[]", "{}", "u1");
    const created = db
      .prepare(
        `SELECT guestUploadEnabled, guestCommentVisibilityEnabled FROM "Drawing" WHERE id = 'd2'`,
      )
      .get() as { guestUploadEnabled: number; guestCommentVisibilityEnabled: number };
    expect(created).toEqual({ guestUploadEnabled: 0, guestCommentVisibilityEnabled: 1 });
  });

  it("writes the historical values explicitly in both provider migrations", () => {
    for (const provider of ["sqlite", "postgresql"]) {
      const sql = readFileSync(
        new URL(
          `../../../prisma/migrations/${provider}/${TARGET_MIGRATION}/migration.sql`,
          import.meta.url,
        ),
        "utf8",
      );
      expect(sql).toMatch(/UPDATE "SystemConfig"[\s\S]*"guestUploadEnabled" = false/);
      expect(sql).toMatch(/UPDATE "SystemConfig"[\s\S]*"guestCommentVisibilityEnabled" = true/);
      expect(sql).toMatch(/UPDATE "Drawing"[\s\S]*"guestUploadEnabled" = false/);
      expect(sql).toMatch(/UPDATE "Drawing"[\s\S]*"guestCommentVisibilityEnabled" = true/);
    }
  });
});
