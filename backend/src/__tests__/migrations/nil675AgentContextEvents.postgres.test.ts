import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260829143000_add_agent_context_events";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-675 postgres migration: Agent Context event log", () => {
    it("requires the real Postgres service in CI", () => {
      throw new Error("POSTGRES_TEST_URL is required for the NIL-675 migration proof.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-675 postgres migration: Agent Context event log",
    () => {
      let client: Client | null = null;
      afterEach(async () => {
        await client?.end();
        client = null;
      });

      const migrated = async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "nil675_agent_context_events_test");
        await applyPostgresMigrationsBefore(client, TARGET);
        await client.query(
          `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
           VALUES ('u1','nil675@example.com','x','Owner','USER',now(),now())`,
        );
        await client.query(
          `INSERT INTO "Drawing" (id,name,elements,"appState","userId","createdAt","updatedAt")
           VALUES ('d1','Board','[]','{}','u1',now(),now())`,
        );
        await client.query(
          `INSERT INTO "AgentContext" (id,"drawingId","frameElementId","updatedAt")
           VALUES ('c1','d1','frame-1',now())`,
        );
        await applyPostgresMigration(client, TARGET);
        return client;
      };

      it("preserves Contexts, enforces sequence uniqueness and cascades events", async () => {
        const handle = await migrated();
        const existing = await handle.query(
          `SELECT id,"nextEventSequence" FROM "AgentContext" WHERE id='c1'`,
        );
        expect(existing.rows[0]).toEqual({ id: "c1", nextEventSequence: 0 });
        const insert = (id: string) =>
          handle.query(
            `INSERT INTO "AgentContextEvent"
             (id,"contextId",sequence,"actorKind","actorId","actorDisplayName","eventKind",payload)
             VALUES ($1,'c1',1,'agent','agent-1','Research','message','{"text":"A"}')`,
            [id],
          );
        await insert("e1");
        await expect(insert("e2")).rejects.toThrow(/duplicate key/i);
        await handle.query(`DELETE FROM "AgentContext" WHERE id='c1'`);
        expect((await handle.query(`SELECT id FROM "AgentContextEvent"`)).rows).toEqual([]);
      });
    },
  );
}
