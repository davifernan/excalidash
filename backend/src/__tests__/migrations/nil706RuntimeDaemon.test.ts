import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260830145000_add_runtime_daemons";

describe("NIL-706 sqlite migration: outbound runtime daemons", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  it("adds hashed pairing/device state with owner cascades and no invented legacy rows", () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    db.prepare(
      `INSERT INTO "User" (id,email,passwordHash,name,role,createdAt,updatedAt)
       VALUES ('u1','nil706@example.com','x','Owner','USER',datetime('now'),datetime('now'))`,
    ).run();
    applySqliteMigration(db, TARGET);
    expect(db.prepare(`SELECT * FROM "AgentRuntimeDaemon"`).all()).toEqual([]);
    db.prepare(
      `INSERT INTO "AgentRuntimeDaemon"
       (id,ownerUserId,label,credentialHash,daemonVersion,profiles,policyCapabilities,costBearerLabel,updatedAt)
       VALUES ('device','u1','Laptop','hash-only','0.16.0','[]','[]','Owner',datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentRuntimePairing"
       (id,ownerUserId,codeHash,label,expiresAt)
       VALUES ('pair','u1','pair-hash-only','Laptop',datetime('now','+10 minutes'))`,
    ).run();
    db.prepare(`DELETE FROM "User" WHERE id='u1'`).run();
    expect(db.prepare(`SELECT * FROM "AgentRuntimeDaemon"`).all()).toEqual([]);
    expect(db.prepare(`SELECT * FROM "AgentRuntimePairing"`).all()).toEqual([]);
  });
});
