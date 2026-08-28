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
 * NIL-356: comment on an element, mention a teammate, they get notified,
 * open the deep link, reply, resolve -- all with REAL, DISTINCT accounts.
 *
 * Comments/mentions/notifications/activity require a real authenticated
 * account by product design (docs/product/COMMENTS_GUEST_POLICY.md) -- there
 * is no anonymous authorship. Every other spec in this suite runs against
 * the shared no-auth "bootstrap identity" global-setup.ts turns on once for
 * the whole run, so this spec has to flip real auth on for itself, run the
 * scenario with real accounts, and flip it back off -- without leaving that
 * switch, or any account it created, behind for the next spec file in the
 * queue.
 *
 * ---------------------------------------------------------------------
 * HOW TO RUN THIS SPEC
 * ---------------------------------------------------------------------
 * This spec deliberately does NOT run against the shared dev backend the
 * rest of the suite's `npm test` spins up on ports 8000/6767: toggling real
 * auth on and registering the one-time bootstrap admin is a real, mostly
 * irreversible action against whatever database it targets (see
 * authLifecycle.ts), and this machine may have another session's backend
 * already serving that exact database on those exact ports. Point this run
 * at an isolated backend + frontend + SQLite file instead:
 *
 *   cd backend && DATABASE_URL="file:./e2e-nil324.db" PORT=8842 \
 *     FRONTEND_URL="http://localhost:6842" CSRF_SECRET="e2e-nil324-csrf" \
 *     npm run dev > /path/to/backend-nil324.log 2>&1 &
 *
 *   cd frontend && VITE_DEV_BACKEND_URL="http://localhost:8842" \
 *     npm run dev -- --host --port 6842 &
 *
 *   cd e2e && NO_SERVER=true API_URL="http://localhost:8842" \
 *     BASE_URL="http://localhost:6842" \
 *     E2E_BACKEND_LOG_FILE=/path/to/backend-nil324.log \
 *     npx playwright test comments-two-account.spec.ts --project=chromium
 *
 * The log file is required: the bootstrap setup code is only ever printed
 * to the backend's own stdout (see authLifecycle.ts), never returned over
 * HTTP, by design.
 */

const RUN_ID = Date.now().toString(36);
const ADMIN_EMAIL = "bootstrap@excalidash.local"; // see authLifecycle.ts: reuses the placeholder identity on purpose
const ADMIN_NAME = "Bootstrap Admin";
const ADMIN_PASSWORD = "Nil324-Admin-Setup#1";
const USER_B_EMAIL = `nil324-b-${RUN_ID}@e2e.excalidash.test`;
const USER_B_NAME = "Bridget Beta";
const USER_B_PASSWORD = "Nil324-Bridget#One";
const USER_C_EMAIL = `nil324-c-${RUN_ID}@e2e.excalidash.test`;
const USER_C_NAME = "Carla Gamma";
const USER_C_PASSWORD = "Nil324-Carla#One1";
const DRAWING_NAME = `NIL-324 Comments E2E ${RUN_ID}`;
const MENTION_BODY_TAIL = "please take a look at this shape";
const REPLY_BODY = "On it -- looks good to me";

test.describe
  .serial("NIL-356: two real accounts through comments, mentions, notifications, activity", () => {
  // A dedicated APIRequestContext (not the per-test `request` fixture) so
  // cookies from registerBootstrapAdmin survive from beforeAll, through every
  // test, into afterAll -- the fixture is not guaranteed to be the same
  // instance across those.
  let adminApi: APIRequestContext;
  let userB: { id: string; email: string; name: string } | null = null;
  let userC: { id: string; email: string; name: string } | null = null;
  let drawingId: string | null = null;
  let authWasToggledOn = false;

  test.beforeAll(async () => {
    adminApi = await playwrightRequest.newContext();

    // 1. Flip real auth on. Free (no login needed yet): see authLifecycle.ts.
    const toggled = await toggleAuthEnabled(adminApi, true);
    authWasToggledOn = true;
    expect(toggled.authEnabled).toBe(true);

    // 2. Read the one-time setup code the toggle above just printed, and use
    // it to complete the forced first-admin registration.
    const setupCode = await readLatestBootstrapSetupCode({ reason: "auth_enabled_toggle" });
    await registerBootstrapAdmin(adminApi, {
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      password: ADMIN_PASSWORD,
      setupCode,
    });
    // adminApi now carries a real ADMIN session (registration sets auth cookies).

    // 3. Create the two ordinary accounts the scenario needs, directly --
    // no invite email, no self-registration toggle to also revert.
    userB = await createAdminUser(adminApi, {
      email: USER_B_EMAIL,
      name: USER_B_NAME,
      password: USER_B_PASSWORD,
      role: "USER",
    });
    userC = await createAdminUser(adminApi, {
      email: USER_C_EMAIL,
      name: USER_C_NAME,
      password: USER_C_PASSWORD,
      role: "USER",
    });

    // 4. The board the whole scenario happens on, owned by the admin (User A).
    const drawing = await createDrawing(adminApi, {
      name: DRAWING_NAME,
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
    });
    drawingId = drawing.id;

    // 5. User B gets comment access -- required for the mention to actually
    // resolve to a notification at all (mentions only ever notify board
    // members; see commentsDomain.ts's roster re-check). User C gets nothing,
    // which is the point of the negative-path test below.
    await grantDrawingPermission(adminApi, drawing.id, userB.id, "comment");
  });

  test.afterAll(async () => {
    if (!adminApi) return;
    try {
      if (userB) {
        await offboardUser(adminApi, userB.id).catch((error) =>
          console.error("[cleanup] failed to offboard user B:", error),
        );
      }
      if (userC) {
        await offboardUser(adminApi, userC.id).catch((error) =>
          console.error("[cleanup] failed to offboard user C:", error),
        );
      }
      if (drawingId) {
        await deleteDrawing(adminApi, drawingId).catch((error) =>
          console.error("[cleanup] failed to delete drawing:", error),
        );
      }
    } finally {
      // The one step that MUST run regardless of what else failed above:
      // every other spec in this suite depends on authEnabled being back to
      // false. This is the exact mechanism global-setup.ts used to turn it
      // off in the first place (see authLifecycle.ts).
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

  test("A mentions B in a comment; B is notified, opens the deep link, replies; A sees it live; A resolves and deletes the reply; B sees both live; the event reaches the team activity feed", async ({
    browser,
  }, testInfo) => {
    test.skip(!drawingId || !userB, "beforeAll setup did not complete");
    const drawing_id = drawingId as string;

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    try {
      // --- User A: log in for real, open the board, open the comments panel.
      await loginViaUi(pageA, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      await pageA.goto(`/editor/${drawing_id}`);
      await pageA.waitForSelector(".excalidraw", { timeout: 30000 });
      await pageA.waitForTimeout(1000);
      // Comments is a hamburger-menu-only entry, not a header-control icon
      // (see chromeSlots.tsx's "comments" MAIN_MENU_ENTRIES comment): a
      // third header icon alongside invite/share measurably pushed
      // Excalidraw's own collaborator-avatar list into its "+N" collapsed
      // state instead of showing individual avatars.
      await pageA.getByTestId("main-menu-trigger").click();
      await pageA
        .locator('[data-testid="dropdown-menu"]')
        .getByText("Comments", { exact: true })
        .click();
      await expect(pageA.getByTestId("comment-panel")).toBeVisible();
      await pageA.screenshot({ path: testInfo.outputPath("nil-644-comment-composer.png") });

      // Anchor the thread to a point on the canvas (not a bare, unanchored
      // note) -- "Pin a point" runs the same anchor/hit-test path a click on
      // a live element would (see useCommentPlacement.ts), without depending
      // on canvas-coordinate math lining an element up under a fixed pixel
      // across engines/DPI.
      await pageA.getByTestId("comment-begin-placing").click();
      await pageA
        .locator(".excalidraw__canvas.interactive")
        .click({ position: { x: 500, y: 300 } });
      await expect(pageA.getByText("Anchored to point")).toBeVisible();

      // Mention B through the real MentionTextarea "@" trigger, not by
      // typing the wire token directly -- this exercises the actual
      // autocomplete UI (mentionTokens.ts), which is the only way the app
      // ever produces `@[Name](userId)` in normal use.
      const commentInput = pageA.getByTestId("new-comment-input");
      await commentInput.click();
      await commentInput.type("Hey @Brid");
      const suggestion = pageA.getByTestId("mention-suggestions").getByText(USER_B_NAME, {
        exact: true,
      });
      await expect(suggestion).toBeVisible({ timeout: 10000 });
      await suggestion.click();
      // insertMention() moves the caret in a requestAnimationFrame after the
      // click; typing immediately can land a keystroke before that frame
      // runs, and see it get reordered to the end of the value.
      await expect(commentInput).toHaveValue(new RegExp(`@\\[${USER_B_NAME}\\]`));
      await pageA.waitForTimeout(150);
      await commentInput.type(MENTION_BODY_TAIL);
      await pageA.keyboard.press("Shift+Enter");
      await commentInput.type("with a second line");
      await expect(commentInput).toHaveValue(
        new RegExp(`${MENTION_BODY_TAIL}\\nwith a second line`),
      );
      // The composer owns Enter while focused; it must submit here instead
      // of reaching Excalidraw's canvas shortcut handler.
      await pageA.keyboard.press("Enter");

      await expect(pageA.getByTestId("comment-thread").first()).toContainText("with a second line");
      // A real anchor produced a real marker pin on the canvas.
      await expect(pageA.getByTestId("comment-marker").first()).toBeVisible();

      // The comment POST handler emits its "comment-created" socket event to
      // the whole `drawing_<id>` room -- including the author's own connected
      // socket -- before it even sends the HTTP response (commentRoutes.ts),
      // so A's own socket echo of this comment reliably races the create
      // request's own response. useComments.ts's upsertComment (NIL-324) is
      // what keeps this from rendering twice: this assertion is the
      // regression test for that race at the full end-to-end level, not only
      // the unit level (useComments.test.ts simulates the race directly).
      await expect(pageA.getByTestId("comment-thread")).toHaveCount(1);
      const threadOnA = pageA.getByTestId("comment-thread").first();
      await expect(threadOnA).toContainText(MENTION_BODY_TAIL);

      // --- User B: not on the board at all yet -- the inbox has to reach
      // them wherever they are, per the product's own reasoning
      // (commentRoutes.ts's notifyRecipients comment).
      await loginViaUi(pageB, { email: USER_B_EMAIL, password: USER_B_PASSWORD });
      await pageB.goto("/inbox");
      const notification = pageB.getByTestId("inbox-notification").first();
      await expect(notification).toBeVisible({ timeout: 10000 });
      await expect(pageB.getByTestId("inbox-notification")).toHaveCount(1);
      await expect(notification).toHaveAttribute("data-unread", "true");
      await expect(notification).toContainText("mentioned you in");
      await expect(notification).toContainText(DRAWING_NAME);
      await expect(notification).toContainText(MENTION_BODY_TAIL);

      // Deep link: clicking the notification must land B on the exact
      // thread, not just the board.
      await notification.click();
      await pageB.waitForURL(
        (url) =>
          url.pathname === `/editor/${drawing_id}` && url.searchParams.get("thread") !== null,
      );
      await pageB.waitForSelector(".excalidraw", { timeout: 30000 });
      await expect(pageB.getByTestId("comment-thread").first()).toContainText(MENTION_BODY_TAIL, {
        timeout: 10000,
      });

      // The notification is now read -- re-fetching the inbox must reflect it.
      await pageB.goto("/inbox");
      await expect(pageB.getByTestId("inbox-notification").first()).toHaveAttribute(
        "data-unread",
        "false",
      );
      await pageB.goto(
        `/editor/${drawing_id}?thread=${await threadOnA.getAttribute("data-thread-id")}`,
      );
      await pageB.waitForSelector(".excalidraw", { timeout: 30000 });
      await expect(pageB.getByTestId("comment-thread").first()).toBeVisible({ timeout: 10000 });

      // --- B replies. A's browser has been open and connected this whole
      // time -- it must see the reply live, with no reload. (A only ever
      // received this reply through its socket's `onCreated`, which already
      // dedupes by id -- the append-duplication bug above is specific to the
      // acting user's own optimistic local append, not to an observer.)
      const replyInput = pageB.getByTestId("thread-reply-input");
      await replyInput.fill(REPLY_BODY);
      // The submit-on-Enter handler reads React state (replyDraft), not the
      // DOM value directly -- give the fill()'s change event a beat to land
      // before the keypress, the same race as the mention insertion above.
      await expect(replyInput).toHaveValue(REPLY_BODY);
      await pageB.waitForTimeout(150);
      await replyInput.press("Enter");
      await expect(replyInput).toHaveValue("");
      await expect(threadOnA).toContainText(REPLY_BODY, { timeout: 10000 });

      // Same self-echo race as A's own comment above, now on B's own reply --
      // upsertComment covers both, since createThread and reply share it.
      await expect(pageB.getByTestId("comment-row").filter({ hasText: REPLY_BODY })).toHaveCount(1);
      const threadOnB = pageB.getByTestId("comment-thread").first();
      await expect(threadOnB).toContainText(REPLY_BODY);

      // --- A resolves the thread. B must see it flip live too, and lose the
      // reply box the product hides on a resolved thread (CommentPanel.tsx).
      // The default panel filter is "open" (CommentPanel.tsx), which drops a
      // resolved thread out of the list entirely rather than just relabeling
      // its button -- switch both panels to "All" to keep watching it.
      await threadOnA.getByTestId("thread-resolve").click();
      await pageA.getByTestId("comment-filter-all").click();
      await expect(threadOnA.getByTestId("thread-reopen")).toBeVisible();

      await pageB.getByTestId("comment-filter-all").click();
      await expect(threadOnB.getByTestId("thread-reopen")).toBeVisible({ timeout: 10000 });
      await expect(threadOnB.getByTestId("thread-reply-input")).toHaveCount(0);

      // --- A deletes B's reply (moderation: owner/edit-level access may
      // delete out-of-line comments). B must see the tombstone live.
      const replyRowOnA = threadOnA.getByTestId("comment-row").filter({ hasText: REPLY_BODY });
      await replyRowOnA.getByTestId("comment-delete").click();
      await expect(threadOnA).not.toContainText(REPLY_BODY);
      await expect(threadOnA).toContainText("Comment deleted");

      await expect(threadOnB).toContainText("Comment deleted", { timeout: 10000 });
      await expect(threadOnB).not.toContainText(REPLY_BODY);

      // --- The whole story is now on the team activity feed B belongs to
      // (B has comment access on this board). Four distinct actions above
      // each write one ActivityEvent (commentsDomain.ts verbs): A's root
      // comment ("comment.created"), B's reply ("comment.replied"), A's
      // resolve ("comment.resolved"), A's delete of B's reply
      // ("comment.deleted") -- exactly 4, not merely "at least one".
      await pageB.goto("/activity");
      const activityEvents = pageB.getByTestId("activity-event").filter({ hasText: DRAWING_NAME });
      await expect(activityEvents.first()).toBeVisible({ timeout: 10000 });
      await expect(activityEvents).toHaveCount(4);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("a stranger with no board access gets no notification, an empty inbox, and a 404 (not a blank page) on the deep link", async ({
    browser,
  }) => {
    test.skip(!drawingId || !userC, "beforeAll setup did not complete");
    const drawing_id = drawingId as string;

    const contextC = await browser.newContext();
    const pageC = await contextC.newPage();
    try {
      await loginViaUi(pageC, { email: USER_C_EMAIL, password: USER_C_PASSWORD });

      // No standing grant, no mention ever aimed at this account -- the
      // inbox must be genuinely empty, not just "no unread".
      await pageC.goto("/inbox");
      await expect(pageC.getByText("Nothing here yet")).toBeVisible();
      await expect(pageC.getByTestId("inbox-notification")).toHaveCount(0);

      // A deep link built the same way a real notification/activity row
      // would build one -- opening it must 404 with a real error state, not
      // a blank canvas that could be mistaken for "just an empty board".
      await pageC.goto(`/editor/${drawing_id}?thread=nonexistent-or-inaccessible`);
      await expect(pageC.getByText("Unable to open drawing")).toBeVisible({ timeout: 10000 });
      // drawingReadRoutes.ts's 404 body: { error: "Drawing not found", message:
      // "Drawing does not exist" } -- the frontend prefers `message` (see
      // useEditorSceneLoader.ts), so that is the text actually on screen.
      await expect(pageC.getByText("Drawing does not exist").first()).toBeVisible();
      await expect(pageC.locator(".excalidraw")).toHaveCount(0);
      await expect(pageC.getByTestId("comment-panel")).toHaveCount(0);

      // Not a member of any board -- the team feed has nothing to show either.
      await pageC.goto("/activity");
      await expect(
        pageC.getByTestId("activity-event").filter({ hasText: DRAWING_NAME }),
      ).toHaveCount(0);
    } finally {
      await contextC.close();
    }
  });
});
