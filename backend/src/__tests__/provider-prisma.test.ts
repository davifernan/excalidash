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
  // Real `npx prisma generate` against the real schema -- not a fixture --
  // is the point: NIL-597 was `node scripts/provider-prisma.cjs generate`
  // failing against the real file layout via its temp-workspace copy under
  // `os.tmpdir()`, which has no ancestor `package.json` for Prisma's own
  // "auto-install on generate" project-root inference to find. A test that
  // fakes `execFileSync` would pass on either version of the code and prove
  // nothing about the actual failure.
  // Deliberately does NOT call `providerPrisma.runPrisma(["generate"])`
  // against the real schema/client: an earlier version of this test did,
  // and a `postgresql` generate call left the shared `src/generated/client`
  // holding a Postgres-specific query engine binary on disk after the test
  // finished. `vitest.config.ts` runs this whole suite in one shared fork
  // (`singleFork: true`) against a real sqlite `DATABASE_URL`, so every test
  // file that imports the Prisma client after this one then crashed with
  // "engine not found" -- 91 failing tests across 33 files, none of them
  // about Prisma at all. Restoring to sqlite in a `finally` did not fully
  // fix it either: some suites' own `beforeAll` setup still raced the
  // in-place regenerate. The client this whole backend imports from is
  // shared, mutable disk state; a test asserting one specific provider's
  // generate output must never regenerate it in place, only ever prove the
  // same *mechanism* in a location nothing else reads from -- see below.
  it("succeeds when the schema lives anywhere under backendRoot, not just prisma/", () => {
    const backendRoot = path.resolve(__dirname, "../..");
    const realSchema = fs.readFileSync(path.resolve(backendRoot, "prisma/schema.prisma"), "utf8");

    // Isolated on purpose: under `backendRoot` (so `npx`'s own project-root
    // inference finds the real `package.json`, same as production's
    // `docker-entrypoint.sh` sed-rewriting the real file in place) but
    // nowhere near `prisma/schema.prisma` or `src/generated/client`, so
    // this can never race or collide with the shared client every other
    // test file in this suite imports.
    const tmpParent = path.join(backendRoot, ".prisma-workspaces.tmp");
    fs.mkdirSync(tmpParent, { recursive: true });
    const isolatedRoot = fs.mkdtempSync(path.join(tmpParent, "nil597-positive-probe-"));
    const isolatedSchema = path.join(isolatedRoot, "schema.prisma");
    const isolatedClientDir = path.join(isolatedRoot, "generated", "client");
    // `output` is relative to the schema file's own location -- point it at
    // this isolated tree instead of the real `../src/generated/client`.
    fs.writeFileSync(
      isolatedSchema,
      realSchema.replace(
        /output\s*=\s*"[^"]*"/,
        `output = "${isolatedClientDir.replace(/\\/g, "\\\\")}"`,
      ),
    );

    try {
      execFileSync("npx", ["prisma", "generate", "--schema", isolatedSchema], {
        cwd: backendRoot,
        stdio: "pipe",
        encoding: "utf8",
      });
      expect(fs.existsSync(isolatedClientDir)).toBe(true);
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("restores the schema even when the underlying prisma call fails", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const before = fs.readFileSync(schemaPath, "utf8");

    expect(() =>
      providerPrisma.runPrisma(["generate", "--this-flag-does-not-exist"], { stdio: "pipe" }),
    ).toThrow();
    expect(fs.readFileSync(schemaPath, "utf8")).toBe(before);
  }, 30_000);

  // The Gegenprobe NIL-597 itself asks for: prove the fixed code actually
  // fails the same way the unfixed code did, by running the unfixed
  // function body against a throwaway copy of the schema tree -- never by
  // reverting the real fix commit, which would test the wrong tree.
  it("RED PROBE: the pre-fix temp-workspace path reproduces NIL-597's exact failure", () => {
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
