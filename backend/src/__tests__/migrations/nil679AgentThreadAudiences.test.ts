import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260830024500_add_agent_thread_audiences";

describe("NIL-679 sqlite migration: immutable Agent thread audiences", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  const migrated = () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    db.prepare(
      `INSERT INTO "User" (id,email,passwordHash,name,role,createdAt,updatedAt)
       VALUES ('u1','nil679@example.com','x','Owner','USER',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "Drawing" (id,name,elements,appState,userId,createdAt,updatedAt)
       VALUES ('d1','Board','[]','{}','u1',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentContext" (id,drawingId,frameElementId,nextEventSequence,createdAt,updatedAt)
       VALUES ('c1','d1','frame-1',2,datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentContextEvent"
       (id,contextId,sequence,actorKind,actorId,actorDisplayName,eventKind,payload)
       VALUES ('e1','c1',2,'agent','a1','Research','message','{"text":"preserved"}')`,
    ).run();
    applySqliteMigration(db, TARGET);
    return db;
  };

  it("moves the Context history and its sequence into one drawing-audience thread", () => {
    const handle = migrated();
    expect(
      handle
        .prepare(
          `SELECT id,drawingId,threadKind,audienceKind,audienceUserId,contextId,nextEventSequence
           FROM "AgentThread" WHERE id='c1'`,
        )
        .get(),
    ).toEqual({
      id: "c1",
      drawingId: "d1",
      threadKind: "context",
      audienceKind: "drawing",
      audienceUserId: null,
      contextId: "c1",
      nextEventSequence: 2,
    });
    expect(
      handle
        .prepare(`SELECT id,threadId,sequence,payload FROM "AgentThreadEvent" WHERE id='e1'`)
        .get(),
    ).toEqual({ id: "e1", threadId: "c1", sequence: 2, payload: '{"text":"preserved"}' });
    expect(
      handle
        .prepare(`PRAGMA table_info("AgentContext")`)
        .all()
        .map((column: any) => column.name),
    ).not.toContain("nextEventSequence");
    expect(() => handle.prepare(`SELECT id FROM "AgentContextEvent"`).all()).toThrow(
      /no such table/i,
    );
  });

  it("rejects malformed audience rows and keeps one private thread per account and board", () => {
    const handle = migrated();
    const insert = handle.prepare(
      `INSERT INTO "AgentThread"
       (id,drawingId,threadKind,audienceKind,audienceUserId,title,anchorX,anchorY,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
    );
    expect(() => insert.run("bad", "d1", "orchestrator", "private", null, "Bad", 1, 2)).toThrow(
      /CHECK constraint failed/,
    );
    insert.run("p1", "d1", "orchestrator", "private", "u1", "Local", 1, 2);
    expect(() =>
      insert.run("p2", "d1", "orchestrator", "private", "u1", "Duplicate", 3, 4),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("cascades the migrated history with its original Context", () => {
    const handle = migrated();
    handle.prepare(`DELETE FROM "AgentContext" WHERE id='c1'`).run();
    expect(handle.prepare(`SELECT id FROM "AgentThread" WHERE id='c1'`).all()).toEqual([]);
    expect(handle.prepare(`SELECT id FROM "AgentThreadEvent" WHERE id='e1'`).all()).toEqual([]);
  });
});
