/**
 * A migration test instrument that did not exist before NIL-326 (Hans-
 * Friedrich, PR #66): this repo's migration SQL was never actually
 * executed by any test -- `provider-prisma.test.ts` only checks that
 * migration folders are found, never that the SQL inside one does what its
 * own comment promises. That gap is exactly how the sqlite backfill
 * divergence in `20260824012055_add_nil326_discovery_library_lifecycle`
 * (a corrupt-`elements` board silently losing even name search, while its
 * postgresql sibling correctly kept it name-searchable) reached review
 * unmeasured.
 *
 * Deliberately a small helper, not a framework: it runs real migration.sql
 * files against a throwaway `better-sqlite3` `:memory:` database in
 * declared order, and nothing else. A future migration test seeds data
 * with `db.prepare(...)`/`db.exec(...)` directly against the same
 * better-sqlite3 handle -- there is no ORM layer here on purpose, so what a
 * test asserts is exactly the column value the raw SQL produced, not
 * something a query builder reshaped on the way out.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SQLITE_MIGRATIONS_DIR = path.resolve(__dirname, "../../../prisma/migrations/sqlite");

/** Every migration folder name, in the order Prisma applies them (lexical == chronological here). */
export const listSqliteMigrationNames = (): string[] =>
  fs
    .readdirSync(SQLITE_MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

export const createInMemorySqliteDb = (): Database.Database => new Database(":memory:");

/** Executes one migration folder's migration.sql (which may itself carry several statements) as-is. */
export const applySqliteMigration = (db: Database.Database, migrationName: string): void => {
  const sqlPath = path.join(SQLITE_MIGRATIONS_DIR, migrationName, "migration.sql");
  db.exec(fs.readFileSync(sqlPath, "utf8"));
};

/**
 * Applies every migration strictly before `targetMigrationName`, in order,
 * and stops there -- leaving the schema exactly as it was the moment before
 * the target migration ran, so a test can seed pre-migration data and then
 * apply the target itself as its own, separately-assertable step.
 */
export const applySqliteMigrationsBefore = (
  db: Database.Database,
  targetMigrationName: string,
): void => {
  for (const name of listSqliteMigrationNames()) {
    if (name === targetMigrationName) return;
    applySqliteMigration(db, name);
  }
  throw new Error(`Migration '${targetMigrationName}' not found under ${SQLITE_MIGRATIONS_DIR}`);
};
