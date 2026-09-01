import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  API_URL,
  createCollection,
  createDrawing,
  deleteCollection,
  deleteDrawing,
  getCsrfHeaders,
} from "./helpers/api";
import {
  createAdminUser,
  loginViaApi,
  loginViaUi,
  offboardUser,
  readLatestBootstrapSetupCode,
  registerBootstrapAdmin,
  toggleAuthEnabled,
} from "./helpers/authLifecycle";
import { openEditor } from "./helpers/editor";

/**
 * NIL-523: presence is a statement one real account makes about another.
 *
 * Every test below therefore owns two authenticated browser contexts. The
 * member opens and works on one shared board; the collection owner watches a
 * different page and proves the member appears, survives two subsequent
 * presence renders, and disappears after the member's whole context closes.
 *
 * This spec toggles the backend-wide real-auth switch. It must only run via
 * the isolated `presence-two-account` Playwright project against its own
 * backend, frontend and SQLite database (see playwright.config.ts and the CI
 * job), never in the ordinary Chromium shard.
 */

const RUN_ID = Date.now().toString(36);
const ADMIN_EMAIL = "bootstrap@excalidash.local";
const ADMIN_NAME = "Bootstrap Admin";
const ADMIN_PASSWORD = "Nil523-Admin-Setup#1";
const MEMBER_EMAIL = `nil523-member-${RUN_ID}@e2e.excalidash.test`;
const MEMBER_NAME = "Presence Partner";
const MEMBER_PASSWORD = "Nil523-Presence#One1";
const COLLECTION_NAME = `NIL-523 Presence ${RUN_ID}`;
const DRAWING_NAME = `NIL-523 Shared Board ${RUN_ID}`;

const postCollectionShare = async (
  request: APIRequestContext,
  collectionId: string,
  granteeUserId: string,
): Promise<void> => {
  const response = await request.post(`${API_URL}/collections/${collectionId}/shares`, {
    headers: {
      "Content-Type": "application/json",
      ...(await getCsrfHeaders(request)),
    },
    data: { granteeUserId, role: "edit" },
  });
  if (!response.ok()) {
    throw new Error(
      `Grant collection edit access failed: HTTP ${response.status()} ${await response.text()}`,
    );
  }
};

const waitForEditorPresence = async (page: Page): Promise<void> => {
  await expect
    .poll(
      () => page.evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true),
      { timeout: 30_000, message: "member editor socket never connected" },
    )
    .toBe(true);
};

/** Force the same focus-driven poll the product uses and wait for its HTTP answer. */
const refreshPresence = async (page: Page, endpointPath: string): Promise<void> => {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname.endsWith(endpointPath) && candidate.status() === 200,
    { timeout: 15_000 },
  );
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await response;
};

const openMemberEditor = async (context: BrowserContext, drawingId: string): Promise<Page> => {
  const page = await context.newPage();
  await loginViaUi(page, { email: MEMBER_EMAIL, password: MEMBER_PASSWORD });
  await openEditor(page, drawingId, { settleMs: 500 });
  await waitForEditorPresence(page);
  return page;
};

const workOnBoard = async (page: Page, position: { x: number; y: number }): Promise<void> => {
  await page.locator("canvas").last().click({ position });
};

test.describe("NIL-523: two-account presence delivery", () => {
  let adminApi: APIRequestContext;
  let member: { id: string; email: string; name: string } | null = null;
  let collectionId: string | null = null;
  let drawingId: string | null = null;
  let authWasToggledOn = false;

  test.beforeAll(async () => {
    adminApi = await playwrightRequest.newContext();

    const toggled = await toggleAuthEnabled(adminApi, true);
    authWasToggledOn = true;
    expect(toggled.authEnabled).toBe(true);

    if (toggled.bootstrapRequired) {
      const setupCode = await readLatestBootstrapSetupCode({ reason: "auth_enabled_toggle" });
      await registerBootstrapAdmin(adminApi, {
        email: ADMIN_EMAIL,
        name: ADMIN_NAME,
        password: ADMIN_PASSWORD,
        setupCode,
      });
    } else {
      await loginViaApi(adminApi, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    }
    member = await createAdminUser(adminApi, {
      email: MEMBER_EMAIL,
      name: MEMBER_NAME,
      password: MEMBER_PASSWORD,
      role: "USER",
    });

    const collection = await createCollection(adminApi, COLLECTION_NAME);
    collectionId = collection.id;
    const drawing = await createDrawing(adminApi, {
      name: DRAWING_NAME,
      collectionId,
      elements: [],
      files: {},
    });
    drawingId = drawing.id;
    await postCollectionShare(adminApi, collectionId, member.id);
  });

  test.afterAll(async () => {
    if (!adminApi) return;
    try {
      if (drawingId) await deleteDrawing(adminApi, drawingId).catch(() => {});
      if (collectionId) await deleteCollection(adminApi, collectionId).catch(() => {});
      if (member) await offboardUser(adminApi, member.id).catch(() => {});
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

  test("NIL-272: collection-header avatar appears, stays through two renders, and disappears", async ({
    browser,
  }) => {
    test.skip(!collectionId || !drawingId, "beforeAll setup did not complete");
    const observerContext = await browser.newContext();
    let memberContext: BrowserContext | null = await browser.newContext();

    try {
      const observer = await observerContext.newPage();
      await loginViaUi(observer, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      await observer.goto(`/collections?id=${collectionId}`);
      const teamBar = observer.getByTestId("collection-team-bar");
      await expect(teamBar).toBeVisible();
      const memberAvatar = teamBar.locator(
        `[data-testid="member-avatar"][aria-label="${MEMBER_NAME}"]`,
      );
      await expect(memberAvatar).toHaveAttribute("data-online", "false");

      const memberPage = await openMemberEditor(memberContext, drawingId!);
      await refreshPresence(observer, `/dashboard/collections/${collectionId}/presence`);
      await expect(memberAvatar).toHaveAttribute("data-online", "true");

      for (const position of [
        { x: 420, y: 300 },
        { x: 520, y: 360 },
      ]) {
        await workOnBoard(memberPage, position);
        await refreshPresence(observer, `/dashboard/collections/${collectionId}/presence`);
        await expect(memberAvatar).toHaveAttribute("data-online", "true");
      }

      await memberContext.close();
      memberContext = null;
      await refreshPresence(observer, `/dashboard/collections/${collectionId}/presence`);
      await expect(memberAvatar).toHaveAttribute("data-online", "false");
    } finally {
      if (memberContext) await memberContext.close();
      await observerContext.close();
    }
  });

  test("NIL-293: OPEN RIGHT NOW board appears, stays through two renders, and disappears", async ({
    browser,
  }) => {
    test.skip(!collectionId || !drawingId, "beforeAll setup did not complete");
    const observerContext = await browser.newContext();
    let memberContext: BrowserContext | null = await browser.newContext();

    try {
      const observer = await observerContext.newPage();
      await loginViaUi(observer, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      await observer.goto(`/collections?id=${collectionId}`);
      const openBoard = observer.getByRole("button", {
        name: `Open ${DRAWING_NAME}, open right now`,
      });
      await expect(openBoard).toHaveCount(0);

      const memberPage = await openMemberEditor(memberContext, drawingId!);
      await refreshPresence(observer, "/dashboard/presence");
      await expect(openBoard).toBeVisible();

      for (const position of [
        { x: 440, y: 320 },
        { x: 540, y: 380 },
      ]) {
        await workOnBoard(memberPage, position);
        await refreshPresence(observer, "/dashboard/presence");
        await expect(openBoard).toBeVisible();
      }

      await memberContext.close();
      memberContext = null;
      await refreshPresence(observer, "/dashboard/presence");
      await expect(openBoard).toHaveCount(0);
    } finally {
      if (memberContext) await memberContext.close();
      await observerContext.close();
    }
  });

  test("NIL-294: Team Home sidebar and roster status appear, stay through two renders, and disappear", async ({
    browser,
  }) => {
    test.skip(!drawingId, "beforeAll setup did not complete");
    const observerContext = await browser.newContext();
    let memberContext: BrowserContext | null = await browser.newContext();

    try {
      const observer = await observerContext.newPage();
      await loginViaUi(observer, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      await observer.goto("/team");
      const rosterStatus = observer.getByText(`Currently in ${DRAWING_NAME}`, { exact: true });
      const sidebarStatus = observer.getByText(`${MEMBER_NAME} is currently in ${DRAWING_NAME}`, {
        exact: true,
      });
      await expect(rosterStatus).toHaveCount(0);
      await expect(sidebarStatus).toHaveCount(0);

      const memberPage = await openMemberEditor(memberContext, drawingId!);
      await refreshPresence(observer, "/team/presence");
      await expect(rosterStatus).toBeVisible();
      await expect(sidebarStatus).toBeVisible();

      for (const position of [
        { x: 460, y: 340 },
        { x: 560, y: 400 },
      ]) {
        await workOnBoard(memberPage, position);
        await refreshPresence(observer, "/team/presence");
        await expect(rosterStatus).toBeVisible();
        await expect(sidebarStatus).toBeVisible();
      }

      await memberContext.close();
      memberContext = null;
      await refreshPresence(observer, "/team/presence");
      await expect(rosterStatus).toHaveCount(0);
      await expect(sidebarStatus).toHaveCount(0);
    } finally {
      if (memberContext) await memberContext.close();
      await observerContext.close();
    }
  });

  test("Team Home names people without ranking them", async ({ browser }, testInfo) => {
    // The admin account is exactly the one that used to carry a role label, so
    // this is the view where a badge would show if it came back. A member
    // account is signed in too, so the roster has more than one row and the
    // absence is visible rather than vacuous.
    const adminContext = await browser.newContext();
    try {
      const admin = await adminContext.newPage();
      await loginViaUi(admin, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      await admin.goto("/team");
      await expect(admin.getByText(MEMBER_NAME, { exact: false }).first()).toBeVisible();

      // Scoped to the roster, not the page: "Admin" is also the name of a
      // legitimate navigation entry, and the first version of this test failed
      // on it. What is asserted is that the roster ranks nobody -- not that the
      // word is absent from the application.
      const roster = admin.getByTestId("team-roster");
      await expect(roster).toBeVisible();
      // Anchored: a person legitimately named "Owner Something" must not fail
      // this, and a restyled badge must not pass it under other capitalisation.
      await expect(roster.getByText(/^owner$/i)).toHaveCount(0);
      await expect(roster.getByText(/^admin$/i)).toHaveCount(0);

      const shot = testInfo.outputPath("team-home-no-role-labels.png");
      await admin.screenshot({ path: shot });
      await testInfo.attach("team-home-no-role-labels", {
        path: shot,
        contentType: "image/png",
      });
    } finally {
      await adminContext.close();
    }
  });
});
