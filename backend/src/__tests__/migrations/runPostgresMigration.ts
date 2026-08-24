/**
 * The postgres analog to runSqliteMigration.ts (NIL-494): runs real
 * migration.sql files from prisma/migrations/postgresql against a real
 * Postgres connection, in declared order, and nothing else. Not Prisma's own
 * migrate machinery -- the raw SQL, executed the same way `psql` would.
 *
 * A real connection, not an in-process emulator, is the whole point of this
 * file: the postgresql sibling of the NIL-326 migration backfills inside a
 * `DO $$ ... EXCEPTION ... END $$` block (see
 * nil326SearchTextBackfill.postgres.test.ts), and neither `pg-mem` nor any
 * other in-process Postgres emulator reliably executes PL/pgSQL exception
 * handling in an anonymous block -- that is exactly the kind of thing an
 * emulator approximates, not implements.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const POSTGRES_MIGRATIONS_DIR = path.resolve(__dirname, "../../../prisma/migrations/postgresql");

/** Every migration folder name, in the order Prisma applies them (lexical == chronological here). */
export const listPostgresMigrationNames = (): string[] =>
  fs
    .readdirSync(POSTGRES_MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/**
 * The env var this repo's CI wires to a real `postgres:16-alpine` service
 * container (see .github/workflows/test.yml, job `backend-tests`). Not
 * DATABASE_URL: that name is already the SQLite test database vitest.config.ts
 * sets for every other backend test in this run, and conflating the two would
 * make a postgres-only failure look like it came from the sqlite suite.
 */
export const POSTGRES_TEST_URL_ENV_VAR = "POSTGRES_TEST_URL";

export const getPostgresTestUrl = (): string | undefined =>
  process.env[POSTGRES_TEST_URL_ENV_VAR]?.trim() || undefined;

export const createPostgresClient = async (): Promise<Client> => {
  const connectionString = getPostgresTestUrl();
  if (!connectionString) {
    throw new Error(
      `${POSTGRES_TEST_URL_ENV_VAR} is not set -- see getPostgresTestUrl() callers for the skip guard this is meant to sit behind.`,
    );
  }
  const client = new Client({ connectionString });
  await client.connect();
  return client;
};

/** Schema names this helper is allowed to drop/create -- see resetPostgresSchema. */
const SAFE_SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Drops and recreates `schemaName`, then points this connection's
 * `search_path` at it, so each test starts from the same empty database a
 * fresh `:memory:` sqlite handle gives the sqlite side -- this connection is
 * to a real, persistent server, not a throwaway process.
 *
 * `schemaName` is required, not defaulted to `public`: the whole backend
 * test suite runs as one `vitest run` in CI (`singleFork: true`, but that
 * only bounds the OS process count -- test *files* still run concurrently
 * within it, see vitest.config.ts) against one shared Postgres service
 * container. Two migration test files both resetting `public` at once race
 * on the same DDL and fail with things like `duplicate key value violates
 * unique constraint "pg_type_typname_nsp_index"` -- not a flaky test, a
 * shared-mutable-schema bug this helper had until NIL-382 added the second
 * caller of it. Each test file names its own schema so concurrent files
 * never see each other's tables.
 */
export const resetPostgresSchema = async (client: Client, schemaName: string): Promise<void> => {
  if (!SAFE_SCHEMA_NAME.test(schemaName)) {
    throw new Error(`Unsafe Postgres schema name for a test: ${JSON.stringify(schemaName)}`);
  }
  await client.query(
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; CREATE SCHEMA "${schemaName}";`,
  );
  await client.query(`SET search_path TO "${schemaName}"`);
};

/** Executes one migration folder's migration.sql (which may itself carry several statements, including DO $$ blocks) as-is. */
export const applyPostgresMigration = async (
  client: Client,
  migrationName: string,
): Promise<void> => {
  const sqlPath = path.join(POSTGRES_MIGRATIONS_DIR, migrationName, "migration.sql");
  await client.query(fs.readFileSync(sqlPath, "utf8"));
};

/**
 * Applies every migration strictly before `targetMigrationName`, in order,
 * and stops there -- leaving the schema exactly as it was the moment before
 * the target migration ran, so a test can seed pre-migration data and then
 * apply the target itself as its own, separately-assertable step.
 */
export const applyPostgresMigrationsBefore = async (
  client: Client,
  targetMigrationName: string,
): Promise<void> => {
  for (const name of listPostgresMigrationNames()) {
    if (name === targetMigrationName) return;
    await applyPostgresMigration(client, name);
  }
  throw new Error(`Migration '${targetMigrationName}' not found under ${POSTGRES_MIGRATIONS_DIR}`);
};
