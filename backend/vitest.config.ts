import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.integration.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      DATABASE_PROVIDER: "sqlite",
      DATABASE_URL: "file:./prisma/test.db",
      NODE_ENV: "test",
      AUTH_MODE: "local",
    },
    pool: "forks",
    forks: {
      singleFork: true,
    },
    // NIL-703: this runner writes a snapshot only when a suite import fails
    // while resolving the generated Prisma client's package config. It runs in
    // the Vitest fork, rather than in the parent reporter, so the snapshot is
    // the failing process's view of the file.
    runner: "./src/__tests__/prismaClientResolutionDiagnosticsRunner.ts",
  },
});
