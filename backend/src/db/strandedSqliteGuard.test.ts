import { describe, expect, it } from "vitest";
import {
  assertNoStrandedSqliteDatabase,
  strandedSqliteMessage,
  STRANDED_SQLITE_ENV_OVERRIDE,
} from "./strandedSqliteGuard";

const sizes = (map: Record<string, number | null>) => (candidate: string) =>
  candidate in map ? map[candidate]! : null;

describe("a PostgreSQL instance will not start on top of a populated SQLite file", () => {
  it("refuses, and names the file", () => {
    expect(() =>
      assertNoStrandedSqliteDatabase({
        provider: "postgresql",
        candidatePaths: ["/app/prisma/dev.db"],
        sizeOf: sizes({ "/app/prisma/dev.db": 4_096 }),
      }),
    ).toThrow(/\/app\/prisma\/dev\.db/);
  });

  it("says what actually happens, not that something went wrong", () => {
    // The value of this guard is the sentence an operator reads at 2am. If it
    // only said "configuration error", it would send them looking in the wrong
    // place -- which is exactly the failure it exists to prevent.
    const message = strandedSqliteMessage("/app/prisma/dev.db");
    expect(message).toContain("empty instance");
    expect(message).toContain(STRANDED_SQLITE_ENV_OVERRIDE);
    expect(message).toContain("migrate");
  });

  it("ignores an empty file, which is what a fresh volume leaves behind", () => {
    expect(() =>
      assertNoStrandedSqliteDatabase({
        provider: "postgresql",
        candidatePaths: ["/app/prisma/dev.db"],
        sizeOf: sizes({ "/app/prisma/dev.db": 0 }),
      }),
    ).not.toThrow();
  });

  it("ignores a file that is not there at all", () => {
    expect(() =>
      assertNoStrandedSqliteDatabase({
        provider: "postgresql",
        candidatePaths: ["/app/prisma/dev.db"],
        sizeOf: sizes({}),
      }),
    ).not.toThrow();
  });

  it("says nothing on a SQLite instance -- the file being there is the point", () => {
    expect(() =>
      assertNoStrandedSqliteDatabase({
        provider: "sqlite",
        candidatePaths: ["/app/prisma/dev.db"],
        sizeOf: sizes({ "/app/prisma/dev.db": 4_096 }),
      }),
    ).not.toThrow();
  });

  it("lets an operator who has already migrated say so", () => {
    for (const stated of ["true", "1", "yes", "TRUE"]) {
      expect(() =>
        assertNoStrandedSqliteDatabase({
          provider: "postgresql",
          candidatePaths: ["/app/prisma/dev.db"],
          allowOverride: stated,
          sizeOf: sizes({ "/app/prisma/dev.db": 4_096 }),
        }),
      ).not.toThrow();
    }
  });

  it("does not treat a vague value as consent", () => {
    // "maybe" is not a decision. Reading it as one would silently reinstate
    // the failure this guard exists to prevent.
    expect(() =>
      assertNoStrandedSqliteDatabase({
        provider: "postgresql",
        candidatePaths: ["/app/prisma/dev.db"],
        allowOverride: "maybe",
        sizeOf: sizes({ "/app/prisma/dev.db": 4_096 }),
      }),
    ).toThrow();
  });
});

describe("the guard is actually called at startup", () => {
  // A check nobody invokes is the failure mode this codebase keeps meeting:
  // the rule exists, one caller knows about it, and the path that matters does
  // not. Asserting the wiring costs one test and closes that.
  it("runs before anything opens a connection", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const startup = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");

    expect(startup).toContain("assertNoStrandedSqliteDatabase(");
    // Before the server starts listening: refusing after the port is open
    // would leave a window in which the empty instance is reachable.
    const guardAt = startup.indexOf("assertNoStrandedSqliteDatabase(");
    const listenAt = startup.indexOf(".listen(");
    expect(guardAt).toBeGreaterThan(-1);
    if (listenAt > -1) expect(guardAt).toBeLessThan(listenAt);
  });
});
