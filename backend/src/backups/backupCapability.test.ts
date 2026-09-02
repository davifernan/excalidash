import { describe, expect, it } from "vitest";
import { evaluateBackupCapability } from "./backupCapability";
import { pgDumpEnvironment } from "./scheduler";

const base = {
  schedule: "0 3 * * *",
  databaseUrl: "postgresql://app:pw@db:5432/excalidash",
  pgDumpAvailable: true,
  pgDumpPath: "pg_dump",
} as const;

describe("evaluateBackupCapability", () => {
  it("permits startup when no schedule was configured, whatever the provider", () => {
    // Nothing was promised, so nothing is silently broken. This is the branch
    // that keeps the guard from blocking operators who never asked for backups.
    for (const provider of ["sqlite", "postgresql"] as const) {
      const result = evaluateBackupCapability({
        ...base,
        provider,
        schedule: null,
        pgDumpAvailable: false,
        databaseUrl: undefined,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("refuses a scheduled PostgreSQL backup when pg_dump cannot be executed", () => {
    const result = evaluateBackupCapability({
      ...base,
      provider: "postgresql",
      pgDumpAvailable: false,
    });
    expect(result.ok).toBe(false);
    // The message has to name the fix, not just the fault.
    expect(result.findings.join(" ")).toContain("postgresql-client");
  });

  it("permits a scheduled PostgreSQL backup once pg_dump is present", () => {
    expect(evaluateBackupCapability({ ...base, provider: "postgresql" }).ok).toBe(true);
  });

  it("refuses a scheduled SQLite backup whose DATABASE_URL is not a file path", () => {
    // This is the exact shape that shipped: provider says one thing, the URL
    // another, and the backup job quietly writes nothing.
    const result = evaluateBackupCapability({
      ...base,
      provider: "sqlite",
      databaseUrl: "postgresql://app:pw@db:5432/excalidash",
    });
    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toContain("file:");
  });

  it("permits a scheduled SQLite backup with a file: URL", () => {
    const result = evaluateBackupCapability({
      ...base,
      provider: "sqlite",
      databaseUrl: "file:/app/prisma/dev.db",
      pgDumpAvailable: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe("pgDumpEnvironment", () => {
  it("moves every credential into the environment, leaving none for argv", () => {
    // The whole point: a connection URI passed as an argument is visible to
    // anyone who can run `ps`.
    const { env } = pgDumpEnvironment("postgresql://app:s3cr3t@db:5433/excalidash");
    expect(env).toMatchObject({
      PGHOST: "db",
      PGPORT: "5433",
      PGUSER: "app",
      PGPASSWORD: "s3cr3t",
      PGDATABASE: "excalidash",
    });
  });

  it("decodes percent-escaped credentials", () => {
    const { env } = pgDumpEnvironment("postgresql://a%40b:p%3Aw@db/excalidash");
    expect(env.PGUSER).toBe("a@b");
    expect(env.PGPASSWORD).toBe("p:w");
  });

  it("carries the schema through, so a scoped database dumps only its own", () => {
    expect(pgDumpEnvironment("postgresql://db/x?schema=test_42").schema).toBe("test_42");
    expect(pgDumpEnvironment("postgresql://db/x").schema).toBeNull();
  });

  it("passes sslmode along rather than silently downgrading the connection", () => {
    expect(pgDumpEnvironment("postgresql://db/x?sslmode=require").env.PGSSLMODE).toBe("require");
  });
});
