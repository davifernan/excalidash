import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

/**
 * The timer's whole point is that it is the room's clock, not yours. A test
 * that only watches the person who started it would miss the one thing that
 * matters.
 */
test("a started timer counts down for everyone in the room", async ({ browser, request }) => {
  const drawing = await createDrawing(request, { name: "Timer E2E" });

  const open = async (page: Page) => {
    await page.goto(`/editor/${drawing.id}`);
    await page.waitForSelector(".excalidraw", { timeout: 30000 });
    await page.waitForTimeout(2000);
  };

  const host = await browser.newContext();
  const hostPage = await host.newPage();
  await open(hostPage);

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await open(guestPage);
  await hostPage.waitForTimeout(1500);

  const summary = (page: Page) => page.locator(".workshop-timer__summary");
  await expect(summary(hostPage)).toContainText("Timer");

  await summary(hostPage).click();
  await hostPage.waitForTimeout(300);
  const minutes = hostPage.locator(".workshop-timer input");
  await minutes.fill("2");
  // Scoped to the timer's own expanded panel -- NIL-655 put "Start a vote"
  // in the same corner, and a page-wide /start/i match now resolves both.
  await hostPage.locator(".workshop-timer__panel").getByRole("button", { name: /start/i }).click();

  // Both sides must show a countdown, not just the one who pressed start.
  await expect(summary(hostPage)).toContainText(/0[12]:\d\d/, { timeout: 8000 });
  await expect(summary(guestPage)).toContainText(/0[12]:\d\d/, { timeout: 8000 });

  const readSeconds = async (page: Page) => {
    const text = (await summary(page).innerText()).match(/(\d\d):(\d\d)/);
    return text ? Number(text[1]) * 60 + Number(text[2]) : null;
  };
  const before = await readSeconds(guestPage);
  await guestPage.waitForTimeout(2500);
  const after = await readSeconds(guestPage);
  expect(before).not.toBeNull();
  expect(after!).toBeLessThan(before!);

  await host.close();
  await guest.close();
  await deleteDrawing(request, drawing.id);
});
