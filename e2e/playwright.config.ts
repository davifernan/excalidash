import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

// Overridable so a run can stand beside a live instance instead of taking its
// port out from under it. A dev server that grabs the port production is on
// takes the site down for as long as the run lasts.
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT) || 6767;
const BACKEND_PORT = Number(process.env.PORT) || 8000;
const FRONTEND_URL = process.env.BASE_URL || `http://localhost:${FRONTEND_PORT}`;
const BACKEND_URL = process.env.API_URL || `http://localhost:${BACKEND_PORT}`;

/**
 * Specs that run on every engine.
 *
 * Each one turns on something an engine decides rather than this application:
 * canvas geometry and pointer maths, viewport arithmetic, layout thresholds,
 * and the embedded-widget path.
 */
const CROSS_ENGINE_SPECS = [
  "**/sticky-notes.spec.ts",
  "**/sticky-connect.spec.ts",
  "**/invite-here.spec.ts",
  "**/small-windows.spec.ts",
  "**/document-pages.spec.ts",
];

/** Specs that carry the mobile contract. */
const MOBILE_SPECS = ["**/sticky-notes.spec.ts", "**/small-windows.spec.ts"];

/**
 * Specs that toggle real auth on for a backend the rest of the suite shares
 * in its no-auth "bootstrap identity" mode (see comments-two-account.spec.ts's
 * own header comment and helpers/authLifecycle.ts). Running one of these
 * against the shared backend/database every other spec and shard uses breaks
 * every one of them the moment it runs: the toggle is real and backend-wide,
 * not scoped to this spec's own session. Each gets its own project so the
 * default `chromium` project (the one CI's shared shards run) never picks it
 * up, and CI runs it in a separate job against its own isolated backend,
 * frontend, and SQLite file instead.
 */
const REAL_AUTH_SPECS = ["**/comments-two-account.spec.ts"];

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
    // Retries stay enabled so infrastructure flake does not block the queue,
    // but every retry is surfaced instead of being folded into a silent green.
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

  /**
   * Chromium carries the whole suite; the others carry the contracts an engine
   * or a form factor decides. Running all of it four times over would buy
   * repetition rather than coverage, and make the slowest required check three
   * times slower. The selection is by file, so what an engine covers is
   * readable here rather than scattered through tags in the specs.
   */
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
      testIgnore: REAL_AUTH_SPECS,
    },
    {
      // Isolated on purpose: see REAL_AUTH_SPECS above. Only ever invoked
      // explicitly (`--project=two-account`) against a backend/frontend/DB
      // this project's caller stood up itself, never picked up by a bare
      // `playwright test` or `--project=chromium` run.
      name: "two-account",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
      testMatch: REAL_AUTH_SPECS,
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 720 },
      },
      testMatch: CROSS_ENGINE_SPECS,
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 720 },
      },
      testMatch: CROSS_ENGINE_SPECS,
    },
    {
      // The open question in NIL-274: the synthetic Enter that opens a sticky
      // note's label is sent a frame later, and a phone requires a user
      // activation for its keyboard. Whether the activation survives that frame
      // is measurable only on a touch device profile.
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
      testMatch: MOBILE_SPECS,
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
        // Uploaded documents otherwise default to the path they live at inside
        // the container, which nothing outside it may create. The CI workflow
        // has always set this; the local server did not, so every document test
        // failed locally with a missing widget.
        ASSET_STORAGE_DIR:
          process.env.ASSET_STORAGE_DIR ||
          path.resolve(__dirname, "../backend/prisma/e2e-assets"),
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
