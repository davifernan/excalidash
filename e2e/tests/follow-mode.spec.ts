import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

/**
 * NIL-372: Follow ("Follow me") is a persistent relationship. The avatar
 * entry point is covered here; invite-here.spec.ts proves that accepting an
 * invitation enters this same relationship after its initial viewport fit.
 * These three tests are the real-browser convergence evidence the ticket's
 * exit criteria ask for: start/track/cancel, tab inactivity vs. a real
 * departure, and the follower's own brief reconnect. See
 * docs/product/COLLABORATION_NAVIGATION.md for the semantics these assert.
 */

const rect = (id: string, x: number, y: number) => ({
  id,
  type: "rectangle",
  x,
  y,
  width: 160,
  height: 120,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "#ffec99",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});

const openEditor = async (page: Page, drawingId: string) => {
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector(".excalidraw", { timeout: 30000 });
  await page.waitForTimeout(2000);
  return page;
};

// The same clip invite-here.spec.ts uses: clear of the tool row, the
// properties panel and the header notice.
const CANVAS_PATCH = { x: 520, y: 140, width: 560, height: 340 };
const look = (page: Page) => page.screenshot({ clip: CANVAS_PATCH });

const panBy = async (page: Page, dx: number, dy: number) => {
  // A freshly loaded page has no focus on the canvas, so "h" never reaches
  // Excalidraw and the drag that follows is a selection box, not a pan --
  // the same fix collaboration.spec.ts's drawRectangle needed.
  await page.locator(".excalidraw__canvas.interactive").click({ position: { x: 760, y: 400 } });
  await page.keyboard.press("h");
  await page.mouse.move(760, 400);
  await page.mouse.down();
  await page.mouse.move(760 + dx, 400 + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
};

/**
 * A fixed screen point to rest the target's pointer at before comparing two
 * of the follower's screenshots.
 *
 * The root cause CI caught: cursor sharing between peers is independent of
 * Follow, so the target's remote cursor renders on the follower's screen
 * regardless of follow state -- and *causing* a real pan requires moving the
 * target's mouse, which is itself a new cursor-move broadcast. A raw
 * before/after screenshot diff cannot tell "the viewport moved" apart from
 * "the target's cursor moved", because panning by dragging always does both.
 * Parking the pointer at the same screen coordinate before each of the two
 * captures makes the cursor's rendered appearance identical on both sides,
 * so a remaining diff can only be the viewport.
 *
 * The wait before the move matters as much as the move itself: a pointer
 * update inside the sender's own 50ms throttle window (`lastCursorEmit` in
 * useEditorCollaboration.ts) is dropped rather than queued, so parking
 * right after another move can silently land on that earlier position
 * instead of this one.
 */
const REST_POINT = { x: 900, y: 300 };
const parkCursor = async (page: Page) => {
  await page.waitForTimeout(120);
  await page.mouse.move(REST_POINT.x, REST_POINT.y);
  await page.waitForTimeout(300);
};

test.describe("Follow mode", () => {
  let createdDrawingIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdDrawingIds) {
      try {
        await deleteDrawing(request, id);
      } catch {
        // best-effort cleanup
      }
    }
    createdDrawingIds = [];
  });

  test("clicking an avatar starts a persistent follow that tracks the target, and the native disconnect button ends it", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `Follow_Track_${Date.now()}`,
      elements: [rect("a", 700, 400), rect("b", 1900, 1400)],
    });
    createdDrawingIds.push(drawing.id);

    const followerCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const targetCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const follower = await openEditor(await followerCtx.newPage(), drawing.id);
    const target = await openEditor(await targetCtx.newPage(), drawing.id);

    try {
      await expect(follower.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
      await expect(target.locator(".UserList__collaborator .Avatar")).toHaveCount(1);

      // Start following: click the (only) other collaborator's avatar.
      await follower.locator(".UserList__collaborator .Avatar").first().click();
      await expect(follower.locator('[data-follow-viewport="frame"]')).toBeVisible({
        timeout: 5000,
      });
      // The visible indicator and cancel affordance the ticket asked for are
      // Excalidraw's own built-in `FollowMode` badge
      // (`components/FollowMode/FollowMode.tsx`) -- this package does not
      // duplicate it. `docs/product/COLLABORATION_NAVIGATION.md` records why:
      // it already renders on every viewport width, and its disconnect button
      // already goes through the same `onUserFollow`/UNFOLLOW path this
      // package's server-side follow protocol expects.
      await expect(follower.locator(".follow-mode__badge")).toBeVisible({ timeout: 5000 });

      // The target moves; the follower's canvas has to follow without any
      // action of their own.
      const before = await look(follower);
      await panBy(target, -400, -260);
      await expect
        .poll(async () => Buffer.compare(await look(follower), before) !== 0, { timeout: 8000 })
        .toBe(true);

      // The visible cancel affordance: Excalidraw's own disconnect button.
      await follower.locator(".follow-mode__disconnect-btn").click();
      await expect(follower.locator('[data-follow-viewport="frame"]')).toBeHidden({
        timeout: 5000,
      });
      await expect(follower.locator(".follow-mode__badge")).toBeHidden({ timeout: 5000 });

      // And it really stopped: the target moving again leaves the follower's
      // view untouched, the same "not a leash" proof invite-here.spec.ts
      // uses -- with the target's cursor parked at the same screen point
      // before each capture (see parkCursor's own comment), so a real pan
      // cannot hide inside what would otherwise also be a new cursor
      // position.
      await parkCursor(target);
      const afterStop = await look(follower);
      await panBy(target, 500, 300);
      await parkCursor(target);
      expect(Buffer.compare(await look(follower), afterStop)).toBe(0);
    } finally {
      await followerCtx.close();
      await targetCtx.close();
    }
  });

  test("follow survives the target's tab losing focus, and ends only when they really leave", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `Follow_Inactive_${Date.now()}`,
      elements: [rect("a", 700, 400), rect("b", 1900, 1400)],
    });
    createdDrawingIds.push(drawing.id);

    const followerCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const targetCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const follower = await openEditor(await followerCtx.newPage(), drawing.id);
    const target = await openEditor(await targetCtx.newPage(), drawing.id);

    try {
      await follower.locator(".UserList__collaborator .Avatar").first().click();
      await expect(follower.locator('[data-follow-viewport="frame"]')).toBeVisible({
        timeout: 5000,
      });

      // The regression this whole ticket started from: a background tab used
      // to look identical to a real departure and ended follow on the spot.
      await target.evaluate(() => window.dispatchEvent(new Event("blur")));
      // Past AWAY_GRACE_MS (4s, socketCollaborators.ts) -- long enough that
      // this is not merely inside the anti-flicker window.
      await target.waitForTimeout(4_500);
      await expect(follower.locator('[data-follow-viewport="frame"]')).toBeVisible();

      const before = await look(follower);
      await panBy(target, -300, -180);
      await expect
        .poll(async () => Buffer.compare(await look(follower), before) !== 0, { timeout: 8000 })
        .toBe(true);

      // A real departure, by contrast, does end it -- with the explicit
      // message this ticket's contract requires, not a silent stall.
      await target.close();
      await expect(follower.locator('[data-follow-viewport="frame"]')).toBeHidden({
        timeout: 10000,
      });
      await expect(follower.getByText(/disconnected\. Follow mode ended\./i)).toBeVisible({
        timeout: 5000,
      });
    } finally {
      await followerCtx.close();
      await targetCtx.close();
    }
  });

  test("a brief network blip for the follower restores the same follow target on reconnect", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `Follow_Reconnect_${Date.now()}`,
      elements: [rect("a", 700, 400), rect("b", 1900, 1400)],
    });
    createdDrawingIds.push(drawing.id);

    const followerCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const targetCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const follower = await openEditor(await followerCtx.newPage(), drawing.id);
    const target = await openEditor(await targetCtx.newPage(), drawing.id);

    try {
      await follower.locator(".UserList__collaborator .Avatar").first().click();
      await expect(follower.locator('[data-follow-viewport="frame"]')).toBeVisible({
        timeout: 5000,
      });

      await followerCtx.setOffline(true);
      await follower.waitForTimeout(1_500);
      await followerCtx.setOffline(false);

      // Reconnect re-requests the same follow target automatically
      // (`rememberedTarget`, socketRoomLifecycle.ts) -- not a feature of this
      // package, but this package's presence-lifetime fix touches the same
      // reset path, so the existing guarantee has to still hold.
      await expect(follower.locator('[data-follow-viewport="frame"]')).toBeVisible({
        timeout: 15000,
      });

      const before = await look(follower);
      await panBy(target, -260, -160);
      await expect
        .poll(async () => Buffer.compare(await look(follower), before) !== 0, { timeout: 8000 })
        .toBe(true);
    } finally {
      await followerCtx.close();
      await targetCtx.close();
    }
  });
});
