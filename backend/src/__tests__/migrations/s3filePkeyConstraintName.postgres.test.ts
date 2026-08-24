/**
 * `20260506130000_s3file_composite_pk` renames the TABLE "new_S3File" to
 * "S3File" but Postgres does not rename a table's constraints along with it
 * -- the live primary key constraint stayed named "new_S3File_pkey" on every
 * real Postgres database that ever ran this migration. Found while
 * generating the NIL-382 migration (Prisma's own drift detector flagged it
 * against a real Postgres instance); fixed in
 * `20260824120100_fix_s3file_pkey_constraint_name` (postgres-only -- SQLite's
 * composite PK is declared inline with no named constraint, so it never had
 * this drift).
 *
 * Skips (does not silently pass) when POSTGRES_TEST_URL is unset, EXCEPT
 * under CI, where it fails loudly -- same guard as the other postgres
 * migration tests in this directory.
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

const DRIFTING_MIGRATION = "20260506130000_s3file_composite_pk";
const FIX_MIGRATION = "20260824120100_fix_s3file_pkey_constraint_name";

const readS3FilePkeyConstraintName = async (client: Client): Promise<string> => {
  const { rows } = await client.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = '"S3File"'::regclass AND contype = 'p'`,
  );
  return rows[0]?.conname;
};

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("S3File pkey constraint name fix: postgres migration", () => {
    it("POSTGRES_TEST_URL must be set in CI -- the postgres service container is not wired up", () => {
      throw new Error(
        "POSTGRES_TEST_URL is unset under CI=true. This test exists to run against a real " +
          "postgres:16-alpine service container (NIL-496), not to skip.",
      );
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "S3File pkey constraint name fix: postgres migration",
    () => {
      let client: Client | null = null;

      afterEach(async () => {
        await client?.end();
        client = null;
      });

      it("the composite-pk migration alone leaves the constraint misnamed (proves the drift is real)", async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "s3file_pkey_fix_test");
        await applyPostgresMigrationsBefore(client, DRIFTING_MIGRATION);
        await applyPostgresMigration(client, DRIFTING_MIGRATION);

        expect(await readS3FilePkeyConstraintName(client)).toBe("new_S3File_pkey");
      });

      it("the fix migration renames it to the conventional S3File_pkey", async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "s3file_pkey_fix_test");
        await applyPostgresMigrationsBefore(client, FIX_MIGRATION);
        await applyPostgresMigration(client, FIX_MIGRATION);

        expect(await readS3FilePkeyConstraintName(client)).toBe("S3File_pkey");
      });
    },
  );
}
