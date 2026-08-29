import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  applySqliteMigration,
  applySqliteMigrationsBefore,
  createInMemorySqliteDb,
} from "./runSqliteMigration";

const TARGET = "20260829143000_add_agent_context_events";

describe("NIL-675 sqlite migration: Agent Context event log", () => {
  let db: Database.Database | null = null;
  afterEach(() => db?.close());

  const migrated = () => {
    db = createInMemorySqliteDb();
    applySqliteMigrationsBefore(db, TARGET);
    db.prepare(
      `INSERT INTO "User" (id,email,passwordHash,name,role,createdAt,updatedAt)
       VALUES ('u1','nil675@example.com','x','Owner','USER',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "Drawing" (id,name,elements,appState,userId,createdAt,updatedAt)
       VALUES ('d1','Board','[]','{}','u1',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO "AgentContext" (id,drawingId,frameElementId,updatedAt)
       VALUES ('c1','d1','frame-1',datetime('now'))`,
    ).run();
    applySqliteMigration(db, TARGET);
    return db;
  };

  it("preserves existing Contexts and starts their sequence at zero", () => {
    const handle = migrated();
    expect(
      handle.prepare(`SELECT id,nextEventSequence FROM "AgentContext" WHERE id='c1'`).get(),
    ).toEqual({ id: "c1", nextEventSequence: 0 });
  });

  it("enforces one sequence per Context and cascades its append-only history", () => {
    const handle = migrated();
    const insert = handle.prepare(
      `INSERT INTO "AgentContextEvent"
       (id,contextId,sequence,actorKind,actorId,actorDisplayName,eventKind,payload)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    insert.run("e1", "c1", 1, "agent", "agent-1", "Research", "message", '{"text":"A"}');
    expect(() =>
      insert.run("e2", "c1", 1, "agent", "agent-2", "Verifier", "message", '{"text":"B"}'),
    ).toThrow(/UNIQUE constraint failed/);
    handle.prepare(`DELETE FROM "AgentContext" WHERE id='c1'`).run();
    expect(handle.prepare(`SELECT id FROM "AgentContextEvent"`).all()).toEqual([]);
  });
});
