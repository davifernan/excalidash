import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * NIL-376: the workshop timer's on-screen position -- not its countdown,
 * which stays server-synced (workshop-timer.spec.ts already covers that).
 * Default corner, drag, clamp, keyboard nudge, reset, and that dragging one
 * viewer's copy never moves anyone else's.
 */

const corner = (page: Page) => page.getByTestId("workshop-timer-corner");
const handle = (page: Page) => page.getByTestId("workshop-timer-corner-handle");

const containerBox = (page: Page) => page.locator(".excalidraw").boundingBox();

test.describe("workshop timer position", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-timer-pos-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("defaults to the bottom-right corner", async ({ page }) => {
    await openEditor(page, drawingId);
    const container = (await containerBox(page))!;
    const box = (await corner(page).boundingBox())!;

    expect(container.x + container.width - (box.x + box.width)).toBeCloseTo(16, 0);
    expect(container.y + container.height - (box.y + box.height)).toBeCloseTo(16, 0);
  });

  test("the handle, timer and restart action form one visual bar", async ({ page }) => {
    await openEditor(page, drawingId);
    await page.locator(".workshop-timer__summary").click();
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("workshop-timer-restart")).toBeVisible();
    const styles = await corner(page).evaluate((element) => {
      const parent = getComputedStyle(element);
      const children = [
        element.querySelector("[data-testid=workshop-timer-corner-handle]"),
        element.querySelector(".workshop-timer__summary"),
        element.querySelector("[data-testid=workshop-timer-restart]"),
      ].map((child) => getComputedStyle(child!));
      return {
        parentBackground: parent.backgroundColor,
        childBackgrounds: children.map((style) => style.backgroundColor),
        childShadows: children.map((style) => style.boxShadow),
        restartIconOpacity: getComputedStyle(
          element.querySelector("[data-testid=workshop-timer-restart] svg")!,
        ).opacity,
      };
    });
    expect(styles.parentBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.childBackgrounds).toEqual([
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0)",
    ]);
    expect(styles.childShadows).toEqual(["none", "none", "none"]);
    expect(styles.restartIconOpacity).toBe("0.7");
  });

  test("drags to wherever the handle is pulled, and a plain click still opens the panel", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    const before = (await corner(page).boundingBox())!;
    const handleBox = (await handle(page).boundingBox())!;
    const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 200, start.y - 150, { steps: 10 });
    await page.mouse.up();

    const after = (await corner(page).boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(100);
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(80);

    // The drag was on the handle, not the pill -- its own click behaviour is
    // untouched.
    await expect(page.locator(".workshop-timer__panel")).toHaveCount(0);
    await page.locator(".workshop-timer__summary").click();
    await expect(page.locator(".workshop-timer__panel")).toBeVisible();
  });

  test("clamps at the container edge instead of leaving it", async ({ page }) => {
    await openEditor(page, drawingId);
    const container = (await containerBox(page))!;
    const handleBox = (await handle(page).boundingBox())!;
    const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Aim far past the top-left corner.
    await page.mouse.move(container.x - 500, container.y - 500, { steps: 10 });
    await page.mouse.up();

    const box = (await corner(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(container.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(container.y - 1);
  });

  test("arrow keys nudge it, and Home resets to the default corner", async ({ page }) => {
    await openEditor(page, drawingId);
    const container = (await containerBox(page))!;
    const before = (await corner(page).boundingBox())!;

    await handle(page).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");

    const nudged = (await corner(page).boundingBox())!;
    expect(nudged.y).toBeLessThan(before.y);
    expect(nudged.x).toBeLessThan(before.x);

    await page.keyboard.press("Home");
    const reset = (await corner(page).boundingBox())!;
    expect(container.x + container.width - (reset.x + reset.width)).toBeCloseTo(16, 0);
    expect(container.y + container.height - (reset.y + reset.height)).toBeCloseTo(16, 0);
  });

  test("the restart button restarts the timer without changing measured position", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    await page.locator(".workshop-timer__summary").click();
    await page.getByLabel("Minutes").fill("1");
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.locator(".workshop-timer__time")).toHaveText("00:58", { timeout: 5_000 });

    const handleBox = (await handle(page).boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 250, handleBox.y - 200, { steps: 10 });
    await page.mouse.up();

    const beforeRestart = (await corner(page).boundingBox())!;
    const restart = page.getByTestId("workshop-timer-restart");
    await expect(restart).toBeVisible();
    await restart.click();
    await expect(page.locator(".workshop-timer__time")).toHaveText("01:00");
    const afterRestart = (await corner(page).boundingBox())!;

    expect(afterRestart.x).toBeCloseTo(beforeRestart.x, 0);
    expect(afterRestart.y).toBeCloseTo(beforeRestart.y, 0);
  });

  test("survives a reload -- position is remembered per board, locally", async ({ page }) => {
    await openEditor(page, drawingId);
    const handleBox = (await handle(page).boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 200, handleBox.y - 150, { steps: 10 });
    await page.mouse.up();
    const dragged = (await corner(page).boundingBox())!;

    await page.reload();
    await page.waitForSelector("canvas");
    await page.waitForFunction(
      () => !!(window as unknown as Record<string, unknown>).__EXCALIDASH_TEST__,
    );
    const afterReload = (await corner(page).boundingBox())!;
    expect(afterReload.x).toBeCloseTo(dragged.x, 0);
    expect(afterReload.y).toBeCloseTo(dragged.y, 0);
  });

  test("is local only: dragging one viewer's copy never moves another's", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    await openEditor(host, drawingId);
    await openEditor(guest, drawingId);
    const guestBefore = (await corner(guest).boundingBox())!;
    const guestContainer = (await containerBox(guest))!;

    const handleBox = (await handle(host).boundingBox())!;
    await host.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await host.mouse.down();
    await host.mouse.move(handleBox.x - 300, handleBox.y - 250, { steps: 10 });
    await host.mouse.up();

    await guest.waitForTimeout(500);
    const guestAfter = (await corner(guest).boundingBox())!;
    expect(guestAfter.x).toBeCloseTo(guestBefore.x, 0);
    expect(guestAfter.y).toBeCloseTo(guestBefore.y, 0);
    expect(guestContainer.x + guestContainer.width - (guestAfter.x + guestAfter.width)).toBeCloseTo(
      16,
      0,
    );

    await hostCtx.close();
    await guestCtx.close();
  });
});
