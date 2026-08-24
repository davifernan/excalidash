/**
 * The postgres counterpart to nil382AgentApiKeys.test.ts (NIL-382/NIL-503):
 * runs the real postgresql migration.sql from
 * `prisma/migrations/postgresql/20260824120000_add_nil382_agent_tokens/`
 * against a real Postgres connection -- not a description of what the SQL is
 * supposed to do, the actual SQL, executed. See runPostgresMigration.ts and
 * the `backend-tests` job in .github/workflows/test.yml, which sets
 * POSTGRES_TEST_URL to a real postgres:16-alpine service container (NIL-496).
 *
 * Skips (does not silently pass) when POSTGRES_TEST_URL is unset, EXCEPT
 * under CI, where it fails loudly instead -- same guard as
 * nil326SearchTextBackfill.postgres.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET_MIGRATION = "20260824120000_add_nil382_agent_tokens";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-382 postgres migration: ApiKey.drawingId / ApiKey.expiresAt", () => {
    it("POSTGRES_TEST_URL must be set in CI -- the postgres service container is not wired up", () => {
      throw new Error(
        "POSTGRES_TEST_URL is unset under CI=true. This test exists to run against a real " +
          "postgres:16-alpine service container (NIL-496), not to skip -- check the " +
          "`backend-tests` job in .github/workflows/test.yml.",
      );
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-382 postgres migration: ApiKey.drawingId / ApiKey.expiresAt",
    () => {
      let client: Client | null = null;

      afterEach(async () => {
        await client?.end();
        client = null;
      });

      const seedPreMigrationDb = async (): Promise<Client> => {
        const handle = await createPostgresClient();
        await resetPostgresSchema(handle, "nil382_agent_api_keys_test");
        await applyPostgresMigrationsBefore(handle, TARGET_MIGRATION);

        await handle.query(
          `INSERT INTO "User" (id, email, "passwordHash", name, role, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, now(), now())`,
          ["u1", "a@example.com", "x", "Alice", "USER"],
        );

        await handle.query(
          `INSERT INTO "Drawing" (id, name, elements, "appState", "userId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, now(), now())`,
          ["d1", "Board One", "[]", "{}", "u1"],
        );

        await handle.query(
          `INSERT INTO "ApiKey"
             (id, "userId", name, "keyId", "tokenHash", prefix, scopes, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
          [
            "key-preexisting",
            "u1",
            "Old account key",
            "keyid-old",
            "hash-old",
            "exd_old",
            "drawings:read,drawings:write,collections:read,collections:write",
          ],
        );

        return handle;
      };

      it("leaves a pre-existing account-wide key's new columns NULL", async () => {
        client = await seedPreMigrationDb();
        await applyPostgresMigration(client, TARGET_MIGRATION);

        const { rows } = await client.query(
          `SELECT "drawingId", "expiresAt", scopes, "tokenHash" FROM "ApiKey" WHERE id = $1`,
          ["key-preexisting"],
        );
        const row = rows[0] as {
          drawingId: string | null;
          expiresAt: Date | null;
          scopes: string;
          tokenHash: string;
        };

        expect(row.drawingId).toBeNull();
        expect(row.expiresAt).toBeNull();
        expect(row.scopes).toBe("drawings:read,drawings:write,collections:read,collections:write");
        expect(row.tokenHash).toBe("hash-old");
      });

      it("accepts a new agent key bound to an existing drawing", async () => {
        client = await seedPreMigrationDb();
        await applyPostgresMigration(client, TARGET_MIGRATION);

        await client.query(
          `INSERT INTO "ApiKey"
             (id, "userId", name, "keyId", "tokenHash", prefix, scopes, "drawingId", "expiresAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
          [
            "key-agent",
            "u1",
            "Agent token",
            "keyid-agent",
            "hash-agent",
            "exd_age",
            "drawing:read,drawing:ops",
            "d1",
            "2026-09-23T00:00:00Z",
          ],
        );

        const { rows } = await client.query(
          `SELECT "drawingId", "expiresAt" FROM "ApiKey" WHERE id = $1`,
          ["key-agent"],
        );
        expect(rows[0].drawingId).toBe("d1");
        expect(new Date(rows[0].expiresAt).toISOString()).toBe("2026-09-23T00:00:00.000Z");
      });

      it("enforces the drawingId foreign key -- a key cannot bind to a drawing that does not exist", async () => {
        client = await seedPreMigrationDb();
        await applyPostgresMigration(client, TARGET_MIGRATION);

        await expect(
          client.query(
            `INSERT INTO "ApiKey"
               (id, "userId", name, "keyId", "tokenHash", prefix, scopes, "drawingId", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
            [
              "key-orphan",
              "u1",
              "Orphan agent token",
              "keyid-orphan",
              "hash-orphan",
              "exd_orp",
              "drawing:read",
              "does-not-exist",
            ],
          ),
        ).rejects.toThrow(/foreign key constraint/i);
      });

      it("cascades: deleting the bound drawing deletes its agent key", async () => {
        client = await seedPreMigrationDb();
        await applyPostgresMigration(client, TARGET_MIGRATION);

        await client.query(
          `INSERT INTO "ApiKey"
             (id, "userId", name, "keyId", "tokenHash", prefix, scopes, "drawingId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
          [
            "key-agent",
            "u1",
            "Agent token",
            "keyid-agent",
            "hash-agent",
            "exd_age",
            "drawing:read",
            "d1",
          ],
        );

        await client.query(`DELETE FROM "Drawing" WHERE id = $1`, ["d1"]);

        const { rows } = await client.query(`SELECT id FROM "ApiKey" WHERE id = $1`, ["key-agent"]);
        expect(rows.length).toBe(0);
      });
    },
  );
}
