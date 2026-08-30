import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260830145000_add_runtime_daemons";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-706 postgres migration: outbound runtime daemons", () => {
    it("requires the real Postgres service in CI", () => {
      throw new Error("POSTGRES_TEST_URL is unset under CI=true.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-706 postgres migration: outbound runtime daemons",
    () => {
      let client: Client | null = null;
      afterEach(async () => {
        await client?.end();
        client = null;
      });

      it("installs the same owner-bound hashed state as SQLite", async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "nil706_runtime_daemon_test");
        await applyPostgresMigrationsBefore(client, TARGET);
        await client.query(
          `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
           VALUES ('u1','nil706@example.com','x','Owner','USER',now(),now())`,
        );
        await applyPostgresMigration(client, TARGET);
        await client.query(
          `INSERT INTO "AgentRuntimeDaemon"
           (id,"ownerUserId",label,"credentialHash","daemonVersion",profiles,"policyCapabilities","costBearerLabel","updatedAt")
           VALUES ('device','u1','Laptop','hash-only','0.16.0','[]','[]','Owner',now())`,
        );
        await client.query(
          `INSERT INTO "AgentRuntimePairing"
           (id,"ownerUserId","codeHash",label,"expiresAt")
           VALUES ('pair','u1','pair-hash-only','Laptop',now() + interval '10 minutes')`,
        );
        await client.query(`DELETE FROM "User" WHERE id='u1'`);
        expect((await client.query(`SELECT * FROM "AgentRuntimeDaemon"`)).rows).toEqual([]);
        expect((await client.query(`SELECT * FROM "AgentRuntimePairing"`)).rows).toEqual([]);
      });
    },
  );
}
