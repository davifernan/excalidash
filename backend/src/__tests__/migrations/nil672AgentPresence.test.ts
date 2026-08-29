import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260829150000_add_agent_presence_audience";

describe("NIL-672 sqlite migration: run-scoped Agent Presence audience", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  it("fails legacy mounts closed and persists an explicit private owner", () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    db.prepare(
      `INSERT INTO "User" (id,email,passwordHash,name,role,createdAt,updatedAt)
       VALUES ('u1','nil672@example.com','x','Owner','USER',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "Drawing" (id,name,elements,appState,userId,createdAt,updatedAt)
       VALUES ('d1','Board','[]','{}','u1',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentBoardRevision"
       (id,drawingId,sourceDrawingVersion,contentHash,elements,appState,files,contextMap)
       VALUES ('r1','d1',1,'hash','[]','{}','{}','[]')`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentRunMount"
       (runId,drawingId,revisionId,allowedContextIds,capabilities,capabilityTokenHash)
       VALUES ('legacy','d1','r1','[]','["board:explore"]','legacy-hash')`,
    ).run();

    applySqliteMigration(db, TARGET);
    expect(
      db
        .prepare(
          `SELECT displayName,audienceKind,audienceUserId FROM "AgentRunMount" WHERE runId='legacy'`,
        )
        .get(),
    ).toEqual({ displayName: "Agent", audienceKind: "private", audienceUserId: null });

    db.prepare(
      `INSERT INTO "AgentRunMount"
       (runId,drawingId,revisionId,allowedContextIds,capabilities,capabilityTokenHash,
        displayName,audienceKind,audienceUserId)
       VALUES ('private','d1','r1','[]','["board:explore"]','private-hash',
               'Research','private','u1')`,
    ).run();
    expect(
      db
        .prepare(
          `SELECT displayName,audienceKind,audienceUserId FROM "AgentRunMount" WHERE runId='private'`,
        )
        .get(),
    ).toEqual({ displayName: "Research", audienceKind: "private", audienceUserId: "u1" });
  });
});
