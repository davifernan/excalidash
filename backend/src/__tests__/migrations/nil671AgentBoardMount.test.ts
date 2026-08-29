import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260829130000_add_agent_board_mount";

describe("NIL-671 sqlite migration: immutable agent board mounts", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  const migrated = () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    db.prepare(
      `INSERT INTO "User" (id,email,passwordHash,name,role,createdAt,updatedAt)
       VALUES ('u1','nil671@example.com','x','Owner','USER',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "Drawing" (id,name,elements,appState,userId,createdAt,updatedAt)
       VALUES ('d1','Board','[]','{}','u1',datetime('now'),datetime('now'))`,
    ).run();
    applySqliteMigration(db, TARGET);
    return db;
  };

  it("stores a context, immutable revision, run pin, and hash-only audit", () => {
    const handle = migrated();
    handle
      .prepare(
        `INSERT INTO "AgentContext" (id,drawingId,frameElementId,pinned,updatedAt)
       VALUES ('c1','d1','frame-1',true,datetime('now'))`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO "AgentBoardRevision"
       (id,drawingId,sourceDrawingVersion,contentHash,elements,appState,files,contextMap)
       VALUES ('r1','d1',1,'hash','[]','{}','{}','[]')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO "AgentRunMount"
       (runId,drawingId,revisionId,allowedContextIds,capabilities,capabilityTokenHash)
       VALUES ('run-1','d1','r1','["c1"]','["board:explore"]','token-hash')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO "AgentToolAudit" (id,runId,revisionId,tool,argsHash,resultHash)
       VALUES ('a1','run-1','r1','overview','args-hash','result-hash')`,
      )
      .run();
    expect(
      handle.prepare(`SELECT revisionId,resultHash FROM "AgentToolAudit" WHERE id='a1'`).get(),
    ).toEqual({ revisionId: "r1", resultHash: "result-hash" });
  });

  it("enforces one Context per frame and cascades all mount state with its board", () => {
    const handle = migrated();
    handle
      .prepare(
        `INSERT INTO "AgentContext" (id,drawingId,frameElementId,updatedAt)
       VALUES ('c1','d1','frame-1',datetime('now'))`,
      )
      .run();
    expect(() =>
      handle
        .prepare(
          `INSERT INTO "AgentContext" (id,drawingId,frameElementId,updatedAt)
           VALUES ('c2','d1','frame-1',datetime('now'))`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    handle
      .prepare(
        `INSERT INTO "AgentBoardRevision"
       (id,drawingId,sourceDrawingVersion,contentHash,elements,appState,files,contextMap)
       VALUES ('r1','d1',1,'hash','[]','{}','{}','[]')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO "AgentRunMount"
       (runId,drawingId,revisionId,allowedContextIds,capabilities,capabilityTokenHash)
       VALUES ('run-1','d1','r1','[]','["board:explore"]','token-hash')`,
      )
      .run();
    handle.prepare(`DELETE FROM "Drawing" WHERE id='d1'`).run();
    expect(handle.prepare(`SELECT id FROM "AgentContext"`).all()).toEqual([]);
    expect(handle.prepare(`SELECT id FROM "AgentBoardRevision"`).all()).toEqual([]);
    expect(handle.prepare(`SELECT runId FROM "AgentRunMount"`).all()).toEqual([]);
  });
});
