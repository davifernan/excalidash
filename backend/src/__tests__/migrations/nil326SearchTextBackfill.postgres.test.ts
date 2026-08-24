/**
 * The postgres counterpart to nil326SearchTextBackfill.test.ts (NIL-494):
 * runs the real postgresql migration.sql from
 * `prisma/migrations/postgresql/20260824012055_add_nil326_discovery_library_lifecycle/`
 * against a real Postgres connection -- not a description of what the SQL is
 * supposed to do, the actual SQL, executed.
 *
 * This is the coverage the sqlite test's own file header named as missing:
 * the postgresql migration backfills the corrupt-row fallback inside a
 * `DO $$ ... EXCEPTION ... END $$` block, a construct neither `pg-mem` nor
 * any other in-process Postgres emulator reliably executes. A real
 * `postgres:16-alpine` service container is what makes this test honest --
 * see runPostgresMigration.ts and the `backend-tests` job in
 * .github/workflows/test.yml, which sets POSTGRES_TEST_URL to it.
 *
 * Skips (does not silently pass) when POSTGRES_TEST_URL is unset, EXCEPT
 * under CI, where it fails loudly instead: a migration test that quietly
 * skips itself in the one place it is supposed to run is exactly the
 * `frontend/playwright.config.ts` shape NIL-418 removed from this repo, and
 * this file exists specifically to not repeat it.
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

const TARGET_MIGRATION = "20260824012055_add_nil326_discovery_library_lifecycle";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-326 postgres migration: Drawing.searchText backfill", () => {
    it("POSTGRES_TEST_URL must be set in CI -- the postgres service container is not wired up", () => {
      throw new Error(
        "POSTGRES_TEST_URL is unset under CI=true. This test exists to run against a real " +
          "postgres:16-alpine service container (NIL-494), not to skip -- check the " +
          "`backend-tests` job in .github/workflows/test.yml.",
      );
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-326 postgres migration: Drawing.searchText backfill",
    () => {
      let client: Client | null = null;

      afterEach(async () => {
        await client?.end();
        client = null;
      });

      const seedPreMigrationDb = async (): Promise<Client> => {
        const handle = await createPostgresClient();
        await resetPostgresSchema(handle);
        await applyPostgresMigrationsBefore(handle, TARGET_MIGRATION);

        await handle.query(
          `INSERT INTO "User" (id, email, "passwordHash", name, role, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, now(), now())`,
          ["u1", "a@example.com", "x", "Alice", "USER"],
        );

        await handle.query(
          `INSERT INTO "Drawing" (id, name, elements, "appState", "userId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, now(), now())`,
          [
            "d-valid",
            "Roadmap Q3",
            JSON.stringify([{ type: "text", text: "Ship the roadmap", isDeleted: false }]),
            "{}",
            "u1",
          ],
        );

        await handle.query(
          `INSERT INTO "Drawing" (id, name, elements, "appState", "userId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, now(), now())`,
          ["d-corrupt", "Legacy Board With Corrupt Elements", "not-valid-json", "{}", "u1"],
        );

        return handle;
      };

      it("leaves a board with corrupt elements JSON name-only searchable, not empty", async () => {
        client = await seedPreMigrationDb();
        await applyPostgresMigration(client, TARGET_MIGRATION);

        const { rows } = await client.query(
          `SELECT name, "searchText" FROM "Drawing" WHERE id = $1`,
          ["d-corrupt"],
        );
        const corrupt = rows[0] as { name: string; searchText: string };

        // The exact claim the migration's own comment makes: name-only
        // searchable, not the column default.
        expect(corrupt.searchText).toBe(corrupt.name.toLowerCase());
        expect(corrupt.searchText).not.toBe("");
      });

      it("still computes full name + content search text for a board with valid elements", async () => {
        client = await seedPreMigrationDb();
        await applyPostgresMigration(client, TARGET_MIGRATION);

        const { rows } = await client.query(`SELECT "searchText" FROM "Drawing" WHERE id = $1`, [
          "d-valid",
        ]);
        const valid = rows[0] as { searchText: string };

        expect(valid.searchText).toBe("roadmap q3 ship the roadmap");
      });
    },
  );
}
