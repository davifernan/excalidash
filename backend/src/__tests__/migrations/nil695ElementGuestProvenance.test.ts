import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260829173000_add_element_guest_provenance";

describe("NIL-695 sqlite migration: element guest provenance", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  const migrated = () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    db.prepare(
      `INSERT INTO "User" (id,email,passwordHash,name,role,createdAt,updatedAt)
       VALUES ('u1','nil695@example.com','x','Owner','USER',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "Drawing" (id,name,elements,appState,userId,createdAt,updatedAt)
       VALUES ('d1','Board','[{"id":"legacy"}]','{}','u1',datetime('now'),datetime('now'))`,
    ).run();
    applySqliteMigration(db, TARGET);
    return db;
  };

  it("does not invent a clean provenance row for legacy elements", () => {
    const handle = migrated();
    expect(handle.prepare(`SELECT * FROM "DrawingElementGuestProvenance"`).all()).toEqual([]);
  });

  it("stores both explicit states and cascades them with the drawing", () => {
    const handle = migrated();
    handle
      .prepare(
        `INSERT INTO "DrawingElementGuestProvenance"
         (drawingId,elementId,everGuestTouched,updatedAt)
         VALUES ('d1','guest',true,datetime('now')),('d1','clean',false,datetime('now'))`,
      )
      .run();
    expect(
      handle
        .prepare(
          `SELECT elementId,everGuestTouched FROM "DrawingElementGuestProvenance" ORDER BY elementId`,
        )
        .all(),
    ).toEqual([
      { elementId: "clean", everGuestTouched: 0 },
      { elementId: "guest", everGuestTouched: 1 },
    ]);
    handle.prepare(`DELETE FROM "Drawing" WHERE id='d1'`).run();
    expect(handle.prepare(`SELECT * FROM "DrawingElementGuestProvenance"`).all()).toEqual([]);
  });
});
