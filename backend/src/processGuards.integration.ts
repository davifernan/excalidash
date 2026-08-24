import { spawnSync } from "child_process";
import path from "path";
import { describe, expect, it } from "vitest";

type CrashField = "error" | "reason";

interface CrashLog {
  level?: string;
  message?: string;
  error?: unknown;
  reason?: unknown;
}

const backendRoot = path.resolve(__dirname, "..");

const parseCrashLogs = (stderr: string): CrashLog[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CrashLog];
      } catch {
        return [];
      }
    });

const runCrashProbe = (statement: string) =>
  spawnSync(
    process.execPath,
    [
      "-r",
      require.resolve("ts-node/register/transpile-only"),
      "-e",
      `require("./src/index"); ${statement}`,
    ],
    {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTH_MODE: "local",
        DATABASE_PROVIDER: "sqlite",
        DATABASE_URL: "file:./prisma/test.db",
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
        // Importing index.ts does not listen because it is not the child
        // process's main module. A valid, non-production port still keeps the
        // config boundary honest without occupying the product ports.
        PORT: "1",
      },
      timeout: 20_000,
    },
  );

describe("backend process crash visibility", () => {
  it.each<{
    event: string;
    statement: string;
    logMessage: string;
    field: CrashField;
    marker: string;
  }>([
    {
      event: "unhandled rejection",
      statement: 'void Promise.reject(new Error("NIL-413 rejection probe"));',
      logMessage: "Unhandled promise rejection, exiting",
      field: "reason",
      marker: "NIL-413 rejection probe",
    },
    {
      event: "uncaught exception",
      statement: 'setImmediate(() => { throw new Error("NIL-413 exception probe"); });',
      logMessage: "Uncaught exception, exiting",
      field: "error",
      marker: "NIL-413 exception probe",
    },
  ])(
    "logs a real $event with text and stack before exit",
    ({ statement, logMessage, field, marker }) => {
      const child = runCrashProbe(statement);

      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(1);

      const log = parseCrashLogs(child.stderr).find((line) => line.message === logMessage);
      expect(log).toMatchObject({ level: "error", message: logMessage });
      expect(log?.[field]).toMatchObject({
        name: "Error",
        message: marker,
        stack: expect.stringContaining(marker),
      });
    },
  );
});
