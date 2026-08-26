import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { getCurrentLatestPrismaMigrationName } from "../routes/importExport/shared";

const providerPrisma = require("../../scripts/provider-prisma.cjs") as {
  inferProvider: (env?: Record<string, string | undefined>) => string;
  normalizeDatabaseUrl: (rawUrl?: string) => string;
  rewriteSchemaProvider: (schema: string, provider: string) => string;
  runPrisma: (
    args: string[],
    options?: { env?: Record<string, string>; stdio?: "pipe" | "inherit" },
  ) => unknown;
};

describe("provider Prisma helpers", () => {
  it("prefers an explicit valid DATABASE_PROVIDER over DATABASE_URL inference", () => {
    expect(
      providerPrisma.inferProvider({
        DATABASE_PROVIDER: "sqlite",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/excalidash",
      }),
    ).toBe("sqlite");

    expect(
      providerPrisma.inferProvider({
        DATABASE_PROVIDER: "postgresql",
        DATABASE_URL: "file:./dev.db",
      }),
    ).toBe("postgresql");
  });

  it("infers provider conservatively from DATABASE_URL when DATABASE_PROVIDER is unset", () => {
    expect(
      providerPrisma.inferProvider({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/excalidash",
      }),
    ).toBe("postgresql");
    expect(
      providerPrisma.inferProvider({
        DATABASE_URL: "postgres://user:pass@localhost:5432/excalidash",
      }),
    ).toBe("postgresql");
    expect(providerPrisma.inferProvider({ DATABASE_URL: "file:./dev.db" })).toBe("sqlite");
    expect(providerPrisma.inferProvider({})).toBe("sqlite");
  });

  it("rejects unsupported DATABASE_PROVIDER values before invoking Prisma", () => {
    expect(() =>
      providerPrisma.inferProvider({
        DATABASE_PROVIDER: "mysql",
        DATABASE_URL: "mysql://localhost/excalidash",
      }),
    ).toThrow(/DATABASE_PROVIDER must be 'sqlite' or 'postgresql'/);
  });

  it("normalizes relative sqlite file URLs into backend/prisma paths", () => {
    const backendRoot = path.resolve(__dirname, "../..");

    expect(providerPrisma.normalizeDatabaseUrl("file:./dev.db")).toBe(
      `file:${path.join(backendRoot, "prisma/dev.db")}`,
    );
    expect(providerPrisma.normalizeDatabaseUrl("file:./prisma/dev.db")).toBe(
      `file:${path.join(backendRoot, "prisma/dev.db")}`,
    );
  });

  it("rewrites only the datasource provider and leaves generator providers untouched", () => {
    const schema = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = env("DATABASE_PROVIDER")
  url      = env("DATABASE_URL")
}
`;

    const rewritten = providerPrisma.rewriteSchemaProvider(schema, "postgresql");

    expect(rewritten).toContain('generator client {\n  provider = "prisma-client-js"');
    expect(rewritten).toContain('datasource db {\n  provider = "postgresql"');
    expect(rewritten).not.toContain('provider = env("DATABASE_PROVIDER")');
  });
});

describe("current Prisma migration discovery", () => {
  it("returns the latest concrete sqlite migration when provider folders are present", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "excalidash-migrations-"));
    try {
      const migrationsRoot = path.join(root, "prisma/migrations");
      fs.mkdirSync(path.join(migrationsRoot, "sqlite/20240101000000_initial"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(migrationsRoot, "sqlite/20240201000000_add_drawings"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(migrationsRoot, "postgresql/20240301000000_pg_only"), {
        recursive: true,
      });

      await expect(getCurrentLatestPrismaMigrationName(root)).resolves.toBe(
        "20240201000000_add_drawings",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores provider directory names when falling back to flat migrations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "excalidash-flat-migrations-"));
    try {
      const migrationsRoot = path.join(root, "prisma/migrations");
      fs.mkdirSync(path.join(migrationsRoot, "postgresql"), { recursive: true });
      fs.mkdirSync(path.join(migrationsRoot, "sqlite"), { recursive: true });
      fs.mkdirSync(path.join(migrationsRoot, "20240401000000_flat_migration"), {
        recursive: true,
      });

      await expect(getCurrentLatestPrismaMigrationName(root)).resolves.toBe(
        "20240401000000_flat_migration",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runPrisma generate (NIL-597)", () => {
  // Every test below calls the real, exported `providerPrisma.runPrisma`,
  // not a fake of `execFileSync` and not a hand-rolled replica of Prisma's
  // own behaviour -- Hans's Medium finding on this file's first version was
  // exactly that none of its three tests would go red if the
  // `if (args[0] === "generate")` routing branch in `runPrisma` were
  // reverted: two never called `runPrisma` at all, and the one that did
  // only asserted something equally true of the pre-fix code. Reverting
  // that branch locally and rerunning this file (never committed, per the
  // Dateikopie convention) is exactly what the "generates the client at the
  // real location" test below now catches: it goes red with the reverted
  // routing (the old os.tmpdir() copy path throws NIL-597's original
  // auto-install error) and green with it restored.
  //
  // This is now safe to run against the REAL schema and the REAL shared
  // `src/generated/client` -- unlike the version of this test that caused
  // collateral failures in 33 unrelated files (see the review-fix commit):
  // `runPrismaGenerate` no longer writes anything to `schemaFile`, so there
  // is nothing here to corrupt concurrently, and every call below finishes
  // by regenerating the client for the same sqlite provider
  // `vitest.config.ts`'s `DATABASE_URL` already expects -- the end state on
  // disk is identical to what every other test file in this suite already
  // relies on, not a different provider left behind.
  it("generates the client at the real location and never mutates the tracked schema", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const clientDir = path.resolve(__dirname, "../generated/client");
    const before = fs.readFileSync(schemaPath, "utf8");

    expect(() => providerPrisma.runPrisma(["generate"], { stdio: "pipe" })).not.toThrow();

    expect(fs.existsSync(path.join(clientDir, "default.js"))).toBe(true);
    expect(fs.readFileSync(schemaPath, "utf8")).toBe(before);
  }, 30_000);

  it("rewrites the provider for the requested DATABASE_PROVIDER without touching the tracked schema", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const before = fs.readFileSync(schemaPath, "utf8");

    try {
      expect(() =>
        providerPrisma.runPrisma(["generate"], {
          env: { DATABASE_PROVIDER: "postgresql", DATABASE_URL: "postgresql://x/y" },
          stdio: "pipe",
        }),
      ).not.toThrow();
      expect(fs.readFileSync(schemaPath, "utf8")).toBe(before);
    } finally {
      // Regenerate for the suite's real provider so the shared client on
      // disk stays sqlite for every test file that runs after this one --
      // runs even if the postgres assertions above failed.
      providerPrisma.runPrisma(["generate"], { stdio: "pipe" });
    }
  }, 30_000);

  it("still surfaces a real prisma failure (e.g. a bad flag) instead of swallowing it", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const before = fs.readFileSync(schemaPath, "utf8");

    expect(() =>
      providerPrisma.runPrisma(["generate", "--this-flag-does-not-exist"], { stdio: "pipe" }),
    ).toThrow();
    // Never touched in the first place (not "restored") -- schemaFile is
    // read-only to runPrismaGenerate now, so there is nothing to roll back.
    expect(fs.readFileSync(schemaPath, "utf8")).toBe(before);
  }, 30_000);

  it("leaves no workspace directory behind after a successful call", () => {
    const backendRoot = path.resolve(__dirname, "../..");
    const localTmpRoot = path.join(backendRoot, ".prisma-workspaces.tmp");

    providerPrisma.runPrisma(["generate"], { stdio: "pipe" });

    expect(fs.existsSync(localTmpRoot)).toBe(false);
  }, 30_000);

  // The Gegenprobe NIL-597 itself asks for: prove the *mechanism* the fix
  // relies on, by running the exact pre-fix failure mode (a schema copied
  // under a directory with no ancestor package.json) against real `npx
  // prisma`, isolated from every real file this suite depends on -- never
  // by reverting the actual fix commit, which would test the wrong tree.
  it("RED PROBE: a schema with no ancestor package.json reproduces NIL-597's exact failure", () => {
    const backendRoot = path.resolve(__dirname, "../..");
    const schemaFile = path.resolve(backendRoot, "prisma/schema.prisma");
    const schema = fs.readFileSync(schemaFile, "utf8");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nil597-red-probe-"));
    const workspaceSchema = path.join(tmpRoot, "schema.prisma");
    fs.writeFileSync(workspaceSchema, schema);

    try {
      execFileSync("npx", ["prisma", "generate", "--schema", workspaceSchema], {
        cwd: backendRoot,
        stdio: "pipe",
        encoding: "utf8",
      });
      assert.fail(
        "expected `prisma generate` against a schema copied under os.tmpdir() to fail " +
          "(NIL-597) -- if this now passes, Prisma's own behavior changed and this probe " +
          "needs a new failure signature, not silent deletion",
      );
    } catch (error) {
      const stderr = String((error as { stderr?: Buffer | string }).stderr ?? "");
      expect(stderr).toMatch(/npm i prisma@[\d.]+ -D/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
