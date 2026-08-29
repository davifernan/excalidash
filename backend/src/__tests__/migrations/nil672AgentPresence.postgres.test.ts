import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260829150000_add_agent_presence_audience";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-672 postgres migration", () => {
    it("requires POSTGRES_TEST_URL in CI", () => {
      throw new Error("POSTGRES_TEST_URL is required for the NIL-672 migration contract.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())("NIL-672 postgres migration", () => {
    const clients: Client[] = [];
    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.end()));
    });

    it("adds the fail-closed audience and board-facing agent identity", async () => {
      const client = await createPostgresClient();
      clients.push(client);
      await resetPostgresSchema(client, "nil672_agent_presence_test");
      await applyPostgresMigrationsBefore(client, TARGET);
      await client.query(
        `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
         VALUES ('u1','nil672@example.com','x','Owner','USER',now(),now())`,
      );
      await client.query(
        `INSERT INTO "Drawing" (id,name,elements,"appState","userId","createdAt","updatedAt")
         VALUES ('d1','Board','[]','{}','u1',now(),now())`,
      );
      await client.query(
        `INSERT INTO "AgentBoardRevision"
         (id,"drawingId","sourceDrawingVersion","contentHash",elements,"appState",files,"contextMap")
         VALUES ('r1','d1',1,'hash','[]','{}','{}','[]')`,
      );
      await client.query(
        `INSERT INTO "AgentRunMount"
         ("runId","drawingId","revisionId","allowedContextIds",capabilities,"capabilityTokenHash")
         VALUES ('legacy','d1','r1','[]','["board:explore"]','legacy-hash')`,
      );
      await applyPostgresMigration(client, TARGET);
      expect(
        (
          await client.query(
            `SELECT "displayName","audienceKind","audienceUserId"
             FROM "AgentRunMount" WHERE "runId"='legacy'`,
          )
        ).rows[0],
      ).toEqual({ displayName: "Agent", audienceKind: "private", audienceUserId: null });
    });
  });
}
