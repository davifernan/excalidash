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
  // NIL-340: the M1 close-out's own Pflichtpfade list names Follow/Viewport
  // and UI-Fallbacks as required cross-browser paths. Both were chromium-only
  // until now -- follow-mode.spec.ts drives viewport-follow geometry
  // (definitively engine-decided, the same reason sticky-notes and
  // sticky-connect are already here), and canvas-chrome.spec.ts is the one
  // spec covering the chrome-slot fallback layout a canary upgrade could
  // silently break without any of the collaboration specs noticing.
  "**/follow-mode.spec.ts",
  "**/canvas-chrome.spec.ts",
  // NIL-340: Excalidraw's own native export dialog -- see
  // native-export.spec.ts's own header for why this had no E2E coverage on
  // any engine before this package. View-only share-link rendering is the
  // other half of this Pflichtpfad and is NOT covered here: it needs a real
  // authenticated owner to create the link-share (drawingSharingRoutes.ts's
  // `POST /drawings/:id/link-shares` is `requireAuth`), which puts it in the
  // same isolated-real-auth-project category as comments-two-account.spec.ts
  // and discovery-permission-matrix.spec.ts rather than something to fold
  // into this list. Left as a named gap, not a silent one -- see this
  // package's HANDOFF.
  "**/native-export.spec.ts",
];

/** Specs that carry the mobile contract. */
const MOBILE_SPECS = ["**/sticky-notes.spec.ts", "**/small-windows.spec.ts"];

/**
 * Specs that toggle real auth on for a backend the rest of the suite shares
 * in its no-auth "bootstrap identity" mode (see comments-two-account.spec.ts's
 * own header comment and helpers/authLifecycle.ts). Running one of these
 * against the shared backend/database every other spec and shard uses breaks
 * every one of them the moment it runs: the toggle is real and backend-wide,
 * not scoped to this spec's own session.
 *
 * Each real-auth spec gets its OWN project and its own CI job against its
 * own isolated backend/frontend/SQLite file -- not just excluded from
 * `chromium` and lumped into whichever real-auth project came first.
 * discovery-permission-matrix.spec.ts briefly shared `two-account` in an
 * earlier draft of this list; that would have raced its own bootstrap-admin
 * registration against comments-two-account.spec.ts's the moment CI ran both
 * projects concurrently. One project name per spec keeps the blast radius --
 * and the ownership of who tears the toggle back down in its own afterAll --
 * exactly as narrow as the spec that needs it.
 *
 * `REAL_AUTH_SPECS` (the union of every list below) is what `chromium`'s
 * `testIgnore` reads and what `scripts/real-auth-boundary.cjs` checks against:
 * a spec that imports `toggleAuthEnabled` from `helpers/authLifecycle` but is
 * missing here would otherwise poison every spec sharing its shard the
 * moment it runs -- exactly what happened twice (NIL-356, then NIL-326)
 * before that check existed.
 */
const COMMENTS_TWO_ACCOUNT_SPECS = ["**/comments-two-account.spec.ts"];
const DISCOVERY_PERMISSION_MATRIX_SPECS = ["**/discovery-permission-matrix.spec.ts"];
const REAL_AUTH_SPECS = [...COMMENTS_TWO_ACCOUNT_SPECS, ...DISCOVERY_PERMISSION_MATRIX_SPECS];

/**
 * NIL-330's Team-Readiness-Baseline-Lauf: an operator-triggered multi-hour,
 * multi-context, multi-engine soak, not a per-PR gate. Isolated the same way
 * REAL_AUTH_SPECS is (own project, excluded from chromium/firefox/webkit's
 * default matches) but for a different reason -- there is no toggled backend
 * state to race here, just a runtime budget no ordinary CI run should ever
 * pay by accident. Only ever invoked explicitly
 * (`--project=soak team-readiness`); see e2e/tests/team-readiness.spec.ts's
 * own header for the full runbook.
 */
const SOAK_SPECS = ["**/team-readiness.spec.ts"];

/**
 * team-acceptance.spec.ts (NIL-330's integrated M0 acceptance test) is
 * deliberately one long test (~2.5 minutes alone) rather than several short
 * ones -- see its own header for why. That single fact makes it a poor fit
 * for a chromium shard budgeted to clear 48-65 short tests inside a 720s
 * wall-clock window: PR #76's own CI hit exactly this, shard 2 timing out
 * (SIGKILL after the 30s SIGINT grace period, `playwright-report/` lost,
 * NIL-488's failure mode) with team-acceptance.spec.ts queued to start right
 * as the clock ran out. two-account and permission-matrix already get their
 * own job for a different reason (a real-auth toggle that would poison
 * whatever shard runs beside them); this gets one for a budget reason -- an
 * integration test long enough to matter is long enough to need a job whose
 * timeout is sized for it alone, not shared with everything else in a shard.
 *
 * That job lives in .github/workflows/team-acceptance.yml and runs nightly
 * (plus on demand), not per pull request: see the header there for why it
 * left the merge gate and what it takes to return.
 */
const TEAM_ACCEPTANCE_SPECS = ["**/team-acceptance.spec.ts"];

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

  // Retries were CI-only and set to 2. Measured over four red rounds on
  // 2026-08-23 (PR #54): zero retries recovered a test, twenty retried tests
  // failed again, every one deterministically. A retry that never rescues
  // anything only triples the cost of every red run -- see NIL-491, and
  // e2e/README.md's "Retries" section for the fuller record, including why
  // this also settles NIL-422 (failOnFlakyTests) without setting it.
  retries: 0,

  // A run gone genuinely wrong (bad deploy, hung server) still shows a
  // pattern -- five failures -- instead of grinding through all thirty specs
  // at one worker each before anyone can see why. A green run is unaffected.
  maxFailures: 5,

  workers: 1,

  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report",
        open: "never",
      },
    ],
  ],

  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results",

  timeout: 60000,

  expect: {
    timeout: 10000,
  },

  use: {
    baseURL: FRONTEND_URL,

    // "on-first-retry" depended on a retry ever happening. With retries: 0
    // that is never, so it would have silently stopped capturing anything
    // for a run that fails on its only attempt -- see NIL-488.
    // "retain-on-failure" keeps it exactly when there is something to show.
    trace: "retain-on-failure",

    screenshot: "only-on-failure",

    video: "retain-on-failure",

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
      testIgnore: [...REAL_AUTH_SPECS, ...SOAK_SPECS, ...TEAM_ACCEPTANCE_SPECS],
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
      testMatch: COMMENTS_TWO_ACCOUNT_SPECS,
    },
    {
      // Isolated on purpose, and deliberately its OWN project rather than
      // matched into "two-account" above: see REAL_AUTH_SPECS. Only ever
      // invoked explicitly (`--project=permission-matrix`) against a
      // backend/frontend/DB this project's caller stood up itself.
      name: "permission-matrix",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
      testMatch: DISCOVERY_PERMISSION_MATRIX_SPECS,
    },
    {
      // Isolated on purpose: see TEAM_ACCEPTANCE_SPECS above. Only ever
      // invoked explicitly (`--project=team-acceptance`) against a
      // backend/frontend this project's caller stood up itself.
      name: "team-acceptance",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
      testMatch: TEAM_ACCEPTANCE_SPECS,
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
    {
      // Isolated on purpose: see SOAK_SPECS above. Only ever invoked
      // explicitly (`--project=soak`). The spec launches its own browsers
      // across engines directly rather than through this project's `use`,
      // so this entry exists only to keep the soak spec off every other
      // project's radar.
      name: "soak",
      use: { ...devices["Desktop Chrome"] },
      testMatch: SOAK_SPECS,
      timeout: 0,
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
