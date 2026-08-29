import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260829130000_add_agent_board_mount";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-671 postgres migration", () => {
    it("requires POSTGRES_TEST_URL in CI", () => {
      throw new Error("POSTGRES_TEST_URL is required for the NIL-671 migration contract.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())("NIL-671 postgres migration", () => {
    let client: Client | null = null;
    afterEach(async () => {
      await client?.end();
      client = null;
    });

    it("enforces the run/revision relations and cascades them with the board", async () => {
      client = await createPostgresClient();
      await resetPostgresSchema(client, "nil671_agent_board_mount_test");
      await applyPostgresMigrationsBefore(client, TARGET);
      await client.query(
        `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
         VALUES ('u1','nil671@example.com','x','Owner','USER',now(),now())`,
      );
      await client.query(
        `INSERT INTO "Drawing" (id,name,elements,"appState","userId","createdAt","updatedAt")
         VALUES ('d1','Board','[]','{}','u1',now(),now())`,
      );
      await applyPostgresMigration(client, TARGET);
      await client.query(
        `INSERT INTO "AgentBoardRevision"
         (id,"drawingId","sourceDrawingVersion","contentHash",elements,"appState",files,"contextMap")
         VALUES ('r1','d1',1,'hash','[]','{}','{}','[]')`,
      );
      await client.query(
        `INSERT INTO "AgentRunMount"
         ("runId","drawingId","revisionId","allowedContextIds",capabilities,"capabilityTokenHash")
         VALUES ('run-1','d1','r1','[]','["board:explore"]','token-hash')`,
      );
      await client.query(`DELETE FROM "Drawing" WHERE id='d1'`);
      expect((await client.query(`SELECT id FROM "AgentBoardRevision"`)).rowCount).toBe(0);
      expect((await client.query(`SELECT "runId" FROM "AgentRunMount"`)).rowCount).toBe(0);
    });
  });
}
