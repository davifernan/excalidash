import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260830033000_add_dispatch_receipts";

describe("NIL-679 sqlite migration: public DispatchReceipt", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  it("installs separate admission/execution/effect state and one durable outbox", () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    applySqliteMigration(db, TARGET);

    const columns = db
      .prepare(`PRAGMA table_info("AgentDispatchReceipt")`)
      .all()
      .map((column: any) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "admissionStatus",
        "executionStatus",
        "effectStatus",
        "effectEvidence",
      ]),
    );
    expect(
      db
        .prepare(`PRAGMA table_info("AgentDispatchOutbox")`)
        .all()
        .map((column: any) => column.name),
    ).toEqual(expect.arrayContaining(["dispatchId", "state", "payload", "attemptStartedAt"]));
    expect(() =>
      db!
        .prepare(
          `INSERT INTO "AgentDispatchOutbox" (dispatchId,state,updatedAt)
         VALUES ('missing','invented',datetime('now'))`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
