import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260829162000_add_instruction_approvals";

describe("NIL-676 sqlite migration: instruction approvals", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  const migrated = () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    db.prepare(
      `INSERT INTO "User" (id,email,passwordHash,name,role,createdAt,updatedAt)
       VALUES ('u1','nil676@example.com','x','Owner','USER',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "Drawing" (id,name,elements,appState,userId,createdAt,updatedAt)
       VALUES ('d1','Board','[]','{}','u1',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentContext" (id,drawingId,frameElementId,pinned,updatedAt)
       VALUES ('c1','d1','frame-1',false,datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentBoardRevision"
       (id,drawingId,sourceDrawingVersion,contentHash,elements,appState,files,contextMap)
       VALUES ('r1','d1',1,'hash','[]','{}','{}','[]')`,
    ).run();
    applySqliteMigration(db, TARGET);
    return db;
  };

  it("stores explicit semantic relations and one server approval per Context element", () => {
    const handle = migrated();
    handle
      .prepare(
        `INSERT INTO "AgentSemanticRelation"
         (id,drawingId,contextId,fromElementId,toElementId,kind,createdByUserId,updatedAt)
         VALUES ('rel1','d1','c1','instruction','plan','references','u1',datetime('now'))`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO "AgentInstructionApproval"
         (id,drawingId,contextId,elementId,schemaVersion,semanticHash,closureHash,approvedByUserId,updatedAt)
         VALUES ('approval1','d1','c1','instruction',1,'semantic','closure','u1',datetime('now'))`,
      )
      .run();
    expect(
      handle.prepare(`SELECT "semanticRelations" FROM "AgentBoardRevision" WHERE id='r1'`).get(),
    ).toEqual({ semanticRelations: "[]" });
    expect(() =>
      handle
        .prepare(
          `INSERT INTO "AgentInstructionApproval"
           (id,drawingId,contextId,elementId,schemaVersion,semanticHash,closureHash,approvedByUserId,updatedAt)
           VALUES ('approval2','d1','c1','instruction',1,'semantic2','closure2','u1',datetime('now'))`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("cascades semantic state and approvals with the board", () => {
    const handle = migrated();
    handle
      .prepare(
        `INSERT INTO "AgentInstructionApproval"
         (id,drawingId,contextId,elementId,schemaVersion,semanticHash,closureHash,approvedByUserId,updatedAt)
         VALUES ('approval1','d1','c1','instruction',1,'semantic','closure','u1',datetime('now'))`,
      )
      .run();
    handle.prepare(`DELETE FROM "Drawing" WHERE id='d1'`).run();
    expect(handle.prepare(`SELECT id FROM "AgentInstructionApproval"`).all()).toEqual([]);
    expect(handle.prepare(`SELECT id FROM "AgentSemanticRelation"`).all()).toEqual([]);
  });
});
