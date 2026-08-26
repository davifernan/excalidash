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
 * your click, and that accepting starts the same persistent follow mode as an
 * avatar click. Both halves are checked through the viewport capability the
 * product uses. A canvas screenshot is only a proxy: WebKit can redraw pixels
 * when the pointer or tool changes, and can leave a blank sampled patch
 * unchanged after a real viewport move.
 */
test("accepting an invitation starts persistent follow and the native control stops it", async ({
  browser,
  request,
}, testInfo) => {
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
  await testInfo.attach("invite-before-accept", {
    body: await guestPage.screenshot(),
    contentType: "image/png",
  });

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

  // The first move alone is not proof of follow. The host moves twice more and
  // each distinct viewport must arrive without another action from the guest.
  await markTrace(guestPage, "host-moved-after-accept");
  await showBounds(hostPage, [-800, -700, 480, 20]);
  await expect.poll(async () => (await viewportTrace(guestPage)).length).toBeGreaterThanOrEqual(2);
  const afterFirstFollow = viewportPosition(await viewport(guestPage));
  expect(afterFirstFollow).toEqual(viewportPosition(await viewport(hostPage)));

  await markTrace(guestPage, "host-moved-again");
  await showBounds(hostPage, [1600, 1300, 2880, 2020]);
  await expect.poll(async () => (await viewportTrace(guestPage)).length).toBeGreaterThanOrEqual(3);
  const afterSecondFollow = viewportPosition(await viewport(guestPage));
  expect(afterSecondFollow).toEqual(viewportPosition(await viewport(hostPage)));

  // Accepting uses Excalidraw's native follow state, so it also gets the same
  // visible stop affordance as the avatar-click path.
  await expect(guestPage.locator(".follow-mode__badge")).toBeVisible({ timeout: 5000 });
  await testInfo.attach("invite-after-two-follow-moves", {
    body: await guestPage.screenshot(),
    contentType: "image/png",
  });
  console.log(
    "[invite-follow-evidence]",
    JSON.stringify({
      guestBeforeInvite: viewportPosition(guestBeforeInvite),
      initialAcceptedMove: viewportPosition(acceptedMove.current),
      afterFirstFollow,
      afterSecondFollow,
    }),
  );
  await guestPage.locator(".follow-mode__disconnect-btn").click();
  await expect(guestPage.locator(".follow-mode__badge")).toBeHidden({ timeout: 5000 });

  const afterStop = viewportPosition(await viewport(guestPage));
  await showBounds(hostPage, [300, 200, 1580, 920]);
  await hostPage.waitForTimeout(1500);
  expect(viewportPosition(await viewport(guestPage))).toEqual(afterStop);

  await host.close();
  await guest.close();
  await deleteDrawing(request, drawing.id);
});
