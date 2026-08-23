import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor as openEditorReady } from "./helpers/editor";

/**
 * Chrome in windows that are not the comfortable ones.
 *
 * This used to guard two faults. The second -- our own island sitting on top
 * of Excalidraw's hamburger below 600px tall -- cannot happen any more: the
 * island is gone (NIL-376), its content lives in the hamburger itself now.
 */
const open = (page: Page, id: string) => openEditorReady(page, id, { settleMs: 2200 });

test("the timer's controls stay on screen in a short window", async ({ browser, request }) => {
  // The widget is anchored to the bottom. Opening its panel downwards put Start,
  // Pause and Stop past the edge of a 420px-tall window, where the editor root
  // clips them away entirely -- the timer could be seen but not used.
  const drawing = await createDrawing(request, { name: "Short Window Timer" });
  const context = await browser.newContext({ viewport: { width: 1000, height: 420 } });
  const page = await context.newPage();
  await open(page, drawing.id);

  await page.locator(".workshop-timer__summary").click();
  await page.waitForTimeout(400);

  const offscreen = await page.evaluate(() =>
    [...document.querySelectorAll(".workshop-timer button")]
      .map((button) => ({
        label: (button as HTMLElement).innerText.trim(),
        rect: button.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.bottom > window.innerHeight || rect.top < 0)
      .map(({ label }) => label),
  );
  expect(offscreen).toEqual([]);

  await context.close();
  await deleteDrawing(request, drawing.id);
});

test("the timer's panel stays on screen in the mobile corner", async ({
  browser,
  browserName,
  request,
}) => {
  // Playwright rejects isMobile in Firefox outright, and this test builds its
  // own device context. Skipped rather than quietly weakened: dropping isMobile
  // to make it run would leave a test that says "mobile" and measures a narrow
  // desktop. The mobile-chrome project carries this contract.
  test.skip(browserName === "firefox", "Playwright cannot emulate a mobile device in Firefox");

  // On the mobile layout the widget sits in the bottom-left corner. A panel
  // aligned to its trailing edge grew leftwards from x=16 and put the minutes
  // field at x=-83, on a root that clips -- visible, unusable, and only on a
  // phone.
  const drawing = await createDrawing(request, { name: "Mobile Timer Panel" });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await open(page, drawing.id);

  await page.locator(".workshop-timer__summary").click();
  await page.waitForTimeout(400);

  const offscreen = await page.evaluate(() =>
    [...document.querySelectorAll(".workshop-timer__panel button, .workshop-timer__panel input")]
      .map((control) => ({
        label: (control as HTMLElement).innerText?.trim() || (control as HTMLInputElement).type,
        rect: control.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.left < 0 || rect.right > window.innerWidth)
      .map(({ label }) => label),
  );
  expect(offscreen).toEqual([]);

  await context.close();
  await deleteDrawing(request, drawing.id);
});
