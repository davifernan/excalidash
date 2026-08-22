import { defineConfig, devices } from "@playwright/test";

// Overridable so a run can stand beside a live instance instead of taking its
// port out from under it. A dev server that grabs the port production is on
// takes the site down for as long as the run lasts.
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT) || 6767;
const BACKEND_PORT = Number(process.env.PORT) || 8000;
const FRONTEND_URL = process.env.BASE_URL || `http://localhost:${FRONTEND_PORT}`;
const BACKEND_URL = process.env.API_URL || `http://localhost:${BACKEND_PORT}`;

/**
 * Playwright configuration for E2E browser testing
 * 
 * Environment variables:
 * - BASE_URL: Frontend URL (default: http://localhost:6767)
 * - API_URL: Backend API URL (default: http://localhost:8000)
 * - HEADED: Run in headed mode (default: false)
 * - NO_SERVER: Skip starting servers (default: false)
 */
export default defineConfig({
  testDir: "./tests",

  globalSetup: "./global-setup",

  // The suite uses one backend SQLite database and performs broad cleanup by
  // naming convention, so running tests concurrently creates cross-test leaks.
  fullyParallel: false,

  forbidOnly: !!process.env.CI,

  retries: process.env.CI ? 2 : 0,

  workers: 1,

  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report",
      },
    ],
    ["./playwright-retry-summary-reporter.cjs"],
  ],

  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results",

  timeout: 60000,

  expect: {
    timeout: 10000,
  },

  use: {
    baseURL: FRONTEND_URL,

    trace: "on-first-retry",

    screenshot: "only-on-failure",

    video: "on-first-retry",

    headless: process.env.HEADED !== "true",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  webServer: (process.env.CI || process.env.NO_SERVER === "true") ? undefined : [
    {
      command: "cd ../backend && npm run dev",
      url: `${BACKEND_URL}/health`,
      reuseExistingServer: process.env.E2E_REUSE_SERVER === "true",
      timeout: 120000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        DATABASE_URL: "file:./dev.db",
        PORT: String(BACKEND_PORT),
        FRONTEND_URL,
        CSRF_MAX_REQUESTS: "100000",
        RATE_LIMIT_MAX_REQUESTS: "100000",
        CSRF_SECRET: "e2e-csrf-secret",
      },
    },
    {
      command: `cd ../frontend && npm run dev -- --host --port ${FRONTEND_PORT}`,
      url: FRONTEND_URL,
      reuseExistingServer: process.env.E2E_REUSE_SERVER === "true",
      timeout: 120000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // The dev server proxies /api and /socket.io to this target. Without it,
        // moving the backend off its default port left the frontend talking to
        // whatever happened to be on 8000 -- either nothing, or worse, somebody
        // else's instance.
        VITE_DEV_BACKEND_URL: BACKEND_URL,
      },
    },
  ],
});
