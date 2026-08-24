import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import {
  createAdminUser,
  grantDrawingPermission,
  loginViaUi,
  offboardUser,
  readLatestBootstrapSetupCode,
  registerBootstrapAdmin,
  toggleAuthEnabled,
} from "./helpers/authLifecycle";

/**
 * NIL-326/NIL-366: the package's own central claim, in a real browser with
 * TWO real, distinct accounts -- an account with no claim on a board finds
 * nothing through /search, and learns no count either. The same assertion
 * already has a red-probed, real-database regression test at the query
 * level (`backend/src/routes/dashboard/searchRoutes.test.ts`); this spec is
 * the browser-level confirmation the package's own visual-evidence /
 * end-to-end acceptance line asks for, not a duplicate of that coverage.
 *
 * ---------------------------------------------------------------------
 * HOW TO RUN THIS SPEC
 * ---------------------------------------------------------------------
 * Same reason and same isolation as `comments-two-account.spec.ts` (see
 * that spec's own header): toggling real auth on is a mostly-irreversible
 * action against whatever database it targets, and this machine may have
 * another session's backend already serving the default dev database on
 * the default ports. Point this run at an isolated backend + frontend +
 * SQLite file, e.g.:
 *
 *   cd backend && DATABASE_URL="file:./e2e-nil326.db" PORT=8853 \
 *     FRONTEND_URL="http://localhost:6853" CSRF_SECRET="e2e-nil326-csrf" \
 *     NODE_ENV=development npm run dev > /tmp/backend-nil326.log 2>&1 &
 *
 *   cd frontend && VITE_DEV_BACKEND_URL="http://localhost:8853" \
 *     npm run dev -- --host --port 6853 &
 *
 *   cd e2e && NO_SERVER=true API_URL="http://localhost:8853" \
 *     BASE_URL="http://localhost:6853" \
 *     E2E_BACKEND_LOG_FILE=/tmp/backend-nil326.log \
 *     npx playwright test discovery-permission-matrix.spec.ts --project=chromium
 */

const RUN_ID = Date.now().toString(36);
const ADMIN_EMAIL = "bootstrap@excalidash.local";
const ADMIN_NAME = "Bootstrap Admin";
const ADMIN_PASSWORD = "Nil326-Admin-Setup#1";
const OUTSIDER_EMAIL = `nil326-outsider-${RUN_ID}@e2e.excalidash.test`;
const OUTSIDER_NAME = "Olivia Outsider";
const OUTSIDER_PASSWORD = "Nil326-Olivia#One1";
const DRAWING_NAME = `NIL-326 Permission Matrix ${RUN_ID}`;
const CONTENT_TERM = `permissionMatrixTerm${RUN_ID}`;

test.describe.serial("NIL-326: a search a stranger runs finds nothing and no count", () => {
  let adminApi: APIRequestContext;
  let outsider: { id: string; email: string; name: string } | null = null;
  let drawingId: string | null = null;
  let authWasToggledOn = false;

  test.beforeAll(async () => {
    adminApi = await playwrightRequest.newContext();

    const toggled = await toggleAuthEnabled(adminApi, true);
    authWasToggledOn = true;
    expect(toggled.authEnabled).toBe(true);

    const setupCode = await readLatestBootstrapSetupCode({ reason: "auth_enabled_toggle" });
    await registerBootstrapAdmin(adminApi, {
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      password: ADMIN_PASSWORD,
      setupCode,
    });

    outsider = await createAdminUser(adminApi, {
      email: OUTSIDER_EMAIL,
      name: OUTSIDER_NAME,
      password: OUTSIDER_PASSWORD,
      role: "USER",
    });

    const drawing = await createDrawing(adminApi, {
      name: DRAWING_NAME,
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
    });
    drawingId = drawing.id;
    // Deliberately no grant to `outsider` -- that is the whole point.
  });

  test.afterAll(async () => {
    if (!adminApi) return;
    try {
      if (outsider) {
        await offboardUser(adminApi, outsider.id).catch((error) =>
          console.error("[cleanup] failed to offboard outsider:", error),
        );
      }
      if (drawingId) {
        await deleteDrawing(adminApi, drawingId).catch((error) =>
          console.error("[cleanup] failed to delete drawing:", error),
        );
      }
    } finally {
      try {
        if (authWasToggledOn) {
          const reverted = await toggleAuthEnabled(adminApi, false);
          expect(reverted.authEnabled).toBe(false);
        }
      } finally {
        await adminApi.dispose();
      }
    }
  });

  test("the owner finds their own board; an account with no claim on it finds nothing and sees zero, not a truncated result", async ({
    browser,
  }) => {
    test.skip(!drawingId || !outsider, "beforeAll setup did not complete");

    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await loginViaUi(ownerPage, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    await ownerPage.goto("/search");
    await ownerPage.getByPlaceholder("Search boards by name or content").fill(DRAWING_NAME);
    await expect(ownerPage.getByText(DRAWING_NAME)).toBeVisible();
    await ownerContext.close();

    const outsiderContext = await browser.newContext();
    const outsiderPage = await outsiderContext.newPage();
    await loginViaUi(outsiderPage, { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD });
    await outsiderPage.goto("/search");
    await outsiderPage.getByPlaceholder("Search boards by name or content").fill(DRAWING_NAME);
    await expect(outsiderPage.getByText(DRAWING_NAME)).not.toBeVisible();
    await expect(outsiderPage.getByText("No boards found")).toBeVisible();
    // The zero-results empty state, not a spinner or an error -- the
    // request completed and genuinely found nothing, the same shape as "no
    // one has a board with that name yet" on the whole team.
    await expect(outsiderPage.getByRole("status", { name: "Searching" })).toHaveCount(0);
    await outsiderContext.close();
  });

  test("granting the outsider view access makes the same search find it", async ({ browser }) => {
    test.skip(!drawingId || !outsider, "beforeAll setup did not complete");
    await grantDrawingPermission(adminApi, drawingId as string, (outsider as { id: string }).id, "view");

    const outsiderContext = await browser.newContext();
    const outsiderPage = await outsiderContext.newPage();
    await loginViaUi(outsiderPage, { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD });
    await outsiderPage.goto("/search");
    await outsiderPage.getByPlaceholder("Search boards by name or content").fill(DRAWING_NAME);
    await expect(outsiderPage.getByText(DRAWING_NAME)).toBeVisible();
    // Viewer, not owner -- no Archive control on a board it does not control.
    await expect(
      outsiderPage.getByRole("button", { name: `Archive ${DRAWING_NAME}` }),
    ).not.toBeVisible();
    await outsiderContext.close();
  });
});
