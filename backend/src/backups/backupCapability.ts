/**
 * Refuses startup when scheduled backups are configured but cannot possibly
 * produce an archive.
 *
 * Measured 02.09.2026: `createDatabaseBackup` (then `createSqliteBackup`)
 * answered `null` for every non-`file:` DATABASE_URL, and the scheduler's
 * `addJob` discards its runner's result. With v0.20.0 making PostgreSQL the
 * default provider, a stock deployment therefore ran its backup job on
 * schedule, wrote nothing, and said nothing louder than one `logger.warn` at
 * each firing. The operator's own one-off command (`runOnce.ts`) threw and
 * exited non-zero, so the difference between "backups work" and "backups have
 * never once run" was invisible in exactly the automated path people rely on.
 *
 * A log line is not a guard: nobody reads logs to discover that something did
 * NOT happen. So this converts a silent,
 * permanent loss of the recovery path into an immediate, unmissable startup
 * failure -- the same shape as `strandedSqliteGuard`, and for the same reason.
 *
 * Deliberately narrow: it fires only when BACKUP_SCHEDULE is set. An operator
 * who never asked for scheduled backups is promised nothing and is not blocked
 * from booting.
 */

import { execFileSync } from "node:child_process";

export type BackupProvider = "sqlite" | "postgresql";

export type BackupCapabilityInput = {
  provider: BackupProvider;
  /** BACKUP_SCHEDULE; `null` when the operator did not schedule backups. */
  schedule: string | null;
  databaseUrl?: string;
  /** Whether a usable `pg_dump` executable was found. Probed by the caller. */
  pgDumpAvailable: boolean;
  /** What was probed, for a message that names the fix. */
  pgDumpPath: string;
};

export type BackupCapabilityResult = { ok: boolean; findings: string[] };

export const evaluateBackupCapability = ({
  provider,
  schedule,
  databaseUrl,
  pgDumpAvailable,
  pgDumpPath,
}: BackupCapabilityInput): BackupCapabilityResult => {
  // Nothing was promised, so nothing can be silently broken.
  if (schedule === null) return { ok: true, findings: [] };

  if (provider === "sqlite") {
    if (!databaseUrl || !databaseUrl.startsWith("file:")) {
      return {
        ok: false,
        findings: [
          "BACKUP_SCHEDULE is set and DATABASE_PROVIDER=sqlite, but DATABASE_URL is not a " +
            `\`file:\` path (got ${databaseUrl ? JSON.stringify(databaseUrl) : "no value"}). ` +
            "The SQLite backup path copies the database file, so it cannot run against this URL. " +
            "Either point DATABASE_URL at a file: path or set DATABASE_PROVIDER=postgresql.",
        ],
      };
    }
    return { ok: true, findings: [] };
  }

  if (!pgDumpAvailable) {
    return {
      ok: false,
      findings: [
        `BACKUP_SCHEDULE is set and DATABASE_PROVIDER=postgresql, but \`${pgDumpPath}\` is not ` +
          "executable on this host, so no backup could ever be written. Install the PostgreSQL " +
          "client tools (the backend image ships `postgresql-client`; a custom image may not) " +
          "or point BACKUP_PG_DUMP_PATH at the binary. Unset BACKUP_SCHEDULE only if you " +
          "genuinely intend to run without scheduled backups.",
      ],
    };
  }
  return { ok: true, findings: [] };
};

/**
 * Probes whether `pg_dump` can actually be executed, rather than trusting that
 * a path exists: a file can be present and not executable, and on Alpine the
 * client tools are a separate package from the server.
 */
const probePgDump = (pgDumpPath: string): boolean => {
  try {
    execFileSync(pgDumpPath, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Startup gate. Throws with every finding rather than the first, so an
 * operator fixing a misconfiguration sees the whole picture at once.
 */
export const assertBackupCapability = (input: Omit<BackupCapabilityInput, "pgDumpAvailable">) => {
  const result = evaluateBackupCapability({
    ...input,
    // Only probed when it could matter -- spawning a process on every SQLite
    // startup to answer a question nobody asked is waste.
    pgDumpAvailable:
      input.provider === "postgresql" && input.schedule !== null
        ? probePgDump(input.pgDumpPath)
        : false,
  });
  if (result.ok) return;
  throw new Error(
    `Refusing to start: scheduled backups cannot run.\n  - ${result.findings.join("\n  - ")}`,
  );
};
