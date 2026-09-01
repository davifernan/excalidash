import fs from "node:fs";
import path from "node:path";

/**
 * Refuses to start an instance that was moved to PostgreSQL while its old
 * SQLite database is still sitting there with data in it.
 *
 * The failure this prevents is silent and looks like the worst thing that can
 * happen to a person: they update, the compose file now points at PostgreSQL,
 * the new database is empty, and every board is gone. Nothing errored. The
 * data is still on disk, untouched, and no message says so.
 *
 * Refusing to start is the kinder outcome. A stopped container with a sentence
 * that names the file is recoverable in a minute; a running instance that
 * looks wiped sends somebody to their backups -- or to their own conclusion
 * that the software lost their work.
 *
 * `EXCALIDASH_ALLOW_STRANDED_SQLITE` is the way past it, for the operator who
 * has migrated and deliberately keeps the old file around. It is a decision
 * they state, not a default they inherit.
 */
export const STRANDED_SQLITE_ENV_OVERRIDE = "EXCALIDASH_ALLOW_STRANDED_SQLITE";

export type StrandedSqliteCheck = {
  readonly provider: string | undefined;
  readonly candidatePaths: readonly string[];
  readonly allowOverride?: string | undefined;
  /** Injected so the check is testable without touching a filesystem. */
  readonly sizeOf?: (candidate: string) => number | null;
};

const defaultSizeOf = (candidate: string): number | null => {
  try {
    const info = fs.statSync(candidate);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
};

/**
 * The message, separate from the throw, so the test asserts what an operator
 * actually reads rather than that "an error happened".
 */
export const strandedSqliteMessage = (foundAt: string): string =>
  [
    `This instance is configured for PostgreSQL, but a SQLite database with data is still present at ${foundAt}.`,
    "",
    "Starting would show an empty instance while that file still holds every board, and nothing would say so.",
    "",
    "Either migrate that data into PostgreSQL, or point DATABASE_URL back at the file.",
    `If the data was already migrated and the file is only being kept, set ${STRANDED_SQLITE_ENV_OVERRIDE}=true.`,
  ].join("\n");

export const assertNoStrandedSqliteDatabase = ({
  provider,
  candidatePaths,
  allowOverride,
  sizeOf = defaultSizeOf,
}: StrandedSqliteCheck): void => {
  if (provider !== "postgresql") return;
  const normalized = String(allowOverride ?? "")
    .trim()
    .toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return;

  for (const candidate of candidatePaths) {
    const size = sizeOf(candidate);
    // An empty file is what a stopped container or a fresh volume leaves
    // behind. Only a file with content means somebody's work is in there.
    if (size !== null && size > 0) {
      throw new Error(strandedSqliteMessage(candidate));
    }
  }
};

/** Where the previous default put the database, relative to the backend root. */
export const defaultSqliteCandidatePaths = (backendRoot: string): readonly string[] => [
  path.join(backendRoot, "prisma", "dev.db"),
];
