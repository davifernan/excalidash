import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

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

/**
 * The promise this feature makes is that nothing moves on your screen without
 * your click, and that accepting moves you once rather than tying you to
 * somebody. Both halves are checked through the viewport capability the product
 * uses. A canvas screenshot is only a proxy: WebKit can redraw pixels when the
 * pointer or tool changes, and can leave a blank sampled patch unchanged after
 * a real viewport move.
 */
test("an invitation waits for a click, then moves the view exactly once", async ({
  browser,
  request,
}) => {
  const drawing = await createDrawing(request, {
    name: "Invite E2E",
    elements: [rect("a", 200, 200), rect("b", 1400, 1200)],
  });

  const viewport = (page: Page) =>
    page.evaluate(() => (window as any).__EXCALIDASH_TEST__.getViewport());
  const viewportPosition = ({ zoom, scrollX, scrollY }: any) => ({ zoom, scrollX, scrollY });
  const showBounds = async (page: Page, bounds: readonly number[]) => {
    const result = await page.evaluate(
      (nextBounds) => (window as any).__EXCALIDASH_TEST__.showViewportBounds(nextBounds),
      bounds,
    );
    expect(result.ok).toBe(true);
  };
  const resetTrace = (page: Page, trigger: string) =>
    page.evaluate(
      (nextTrigger) => (window as any).__EXCALIDASH_TEST__.resetViewportTrace(nextTrigger),
      trigger,
    );
  const markTrace = (page: Page, trigger: string) =>
    page.evaluate(
      (nextTrigger) => (window as any).__EXCALIDASH_TEST__.markViewportTrace(nextTrigger),
      trigger,
    );
  const viewportTrace = (page: Page) =>
    page.evaluate(() => (window as any).__EXCALIDASH_TEST__.getViewportTrace());

  const host = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const hostPage = await host.newPage();
  await openEditor(hostPage, drawing.id, { settleMs: 2000 });
  const guest = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const guestPage = await guest.newPage();
  await openEditor(guestPage, drawing.id, { settleMs: 2000 });

  // The host looks somewhere the guest is not. Asserted rather than assumed:
  // if the host never moved, the invitation would be to where the guest already
  // is, and the rest of this test would prove nothing.
  const guestBeforeInvite = await viewport(guestPage);
  await showBounds(hostPage, [900, 800, 2180, 1520]);
  const hostAtInvite = await viewport(hostPage);
  expect(viewportPosition(hostAtInvite)).not.toEqual(viewportPosition(guestBeforeInvite));
  await resetTrace(guestPage, "waiting-for-invite");

  await hostPage.getByTestId("editor-invite").click();
  const overlay = guestPage.locator(".invite-here-overlay");
  await expect(overlay).toBeVisible({ timeout: 8000 });
  await guestPage.waitForTimeout(800);

  // Nothing may have moved yet: the invitation is an offer, not a shove.
  expect(await viewportTrace(guestPage)).toEqual([]);
  expect(viewportPosition(await viewport(guestPage))).toEqual(viewportPosition(guestBeforeInvite));

  await markTrace(guestPage, "accept-clicked");
  await guestPage.getByRole("button", { name: /accept/i }).click();
  await expect(overlay).toBeHidden({ timeout: 5000 });
  await expect.poll(async () => (await viewportTrace(guestPage)).length).toBe(1);
  const [acceptedMove] = await viewportTrace(guestPage);
  expect(acceptedMove).toMatchObject({
    source: "editor.onScrollChange",
    trigger: "accept-clicked",
  });
  expect(viewportPosition(acceptedMove.previous)).toEqual(viewportPosition(guestBeforeInvite));
  expect(viewportPosition(acceptedMove.current)).toEqual(viewportPosition(hostAtInvite));

  // And it was a jump, not a leash: the host moving on leaves the guest be.
  await markTrace(guestPage, "host-moved-after-accept");
  await showBounds(hostPage, [-800, -700, 480, 20]);
  await hostPage.waitForTimeout(1500);
  expect(await viewportTrace(guestPage)).toEqual([acceptedMove]);
  expect(viewportPosition(await viewport(guestPage))).toEqual(
    viewportPosition(acceptedMove.current),
  );

  await host.close();
  await guest.close();
  await deleteDrawing(request, drawing.id);
});
