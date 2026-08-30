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
    options?: {
      env?: Record<string, string>;
      generatedClientOutputDir?: string;
      stdio?: "pipe" | "inherit";
    },
  ) => unknown;
};

const withIsolatedGeneratedClient = <T>(run: (outputDir: string) => T): T => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nil703-generated-client-"));
  const outputDir = path.join(root, "client");
  try {
    return run(outputDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  // These tests call the real exported runPrisma path. Prisma replaces its
  // generated output non-atomically, so the shared client imported by every
  // backend suite must never be regenerated here. Each call instead targets
  // a private temporary output that no other suite can resolve.
  it("generates an isolated client and never mutates the tracked schema or shared client", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const sharedClientPackage = path.resolve(__dirname, "../generated/client/package.json");
    const before = fs.readFileSync(schemaPath, "utf8");
    const sharedBefore = fs.readFileSync(sharedClientPackage);

    withIsolatedGeneratedClient((clientDir) => {
      expect(() =>
        providerPrisma.runPrisma(["generate"], {
          generatedClientOutputDir: clientDir,
          stdio: "pipe",
        }),
      ).not.toThrow();

      expect(fs.existsSync(path.join(clientDir, "default.js"))).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(clientDir, "package.json"), "utf8")),
      ).toBeTruthy();
    });
    expect(fs.readFileSync(schemaPath, "utf8")).toBe(before);
    expect(fs.readFileSync(sharedClientPackage)).toEqual(sharedBefore);
  }, 30_000);

  it("rewrites the provider for the requested DATABASE_PROVIDER without touching the tracked schema", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const before = fs.readFileSync(schemaPath, "utf8");

    withIsolatedGeneratedClient((clientDir) => {
      expect(() =>
        providerPrisma.runPrisma(["generate"], {
          env: { DATABASE_PROVIDER: "postgresql", DATABASE_URL: "postgresql://x/y" },
          generatedClientOutputDir: clientDir,
          stdio: "pipe",
        }),
      ).not.toThrow();
      expect(fs.readFileSync(schemaPath, "utf8")).toBe(before);
    });
  }, 30_000);

  it("still surfaces a real prisma failure (e.g. a bad flag) instead of swallowing it", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const before = fs.readFileSync(schemaPath, "utf8");

    withIsolatedGeneratedClient((clientDir) => {
      expect(() =>
        providerPrisma.runPrisma(["generate", "--this-flag-does-not-exist"], {
          generatedClientOutputDir: clientDir,
          stdio: "pipe",
        }),
      ).toThrow();
    });
    // Never touched in the first place (not "restored") -- schemaFile is
    // read-only to runPrismaGenerate now, so there is nothing to roll back.
    expect(fs.readFileSync(schemaPath, "utf8")).toBe(before);
  }, 30_000);

  it("leaves no workspace directory behind after a successful call", () => {
    const backendRoot = path.resolve(__dirname, "../..");
    const localTmpRoot = path.join(backendRoot, ".prisma-workspaces.tmp");

    withIsolatedGeneratedClient((clientDir) => {
      providerPrisma.runPrisma(["generate"], {
        generatedClientOutputDir: clientDir,
        stdio: "pipe",
      });
    });

    expect(fs.existsSync(localTmpRoot)).toBe(false);
  }, 30_000);
});
