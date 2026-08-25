import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * NIL-578: three findings from Davi, all on the workshop timer.
 *
 *  1. Pressing Start closes the settings panel by itself -- no second click.
 *  2. The pill's background carries the running/not-running state (white
 *     while running, the same muted grey as the rest of the canvas chrome
 *     otherwise) -- asserted on the computed color, not a class name, per
 *     Davi's explicit instruction on the ticket.
 *  3. Running out draws attention: the finished state (and its color
 *     change) reaches every participant in the room, not just the one who
 *     started the timer.
 */

const summary = (page: Page) => page.locator(".workshop-timer__summary");
const panel = (page: Page) => page.locator(".workshop-timer__panel");

// The state color actually lives on the corner container, not the pill --
// WorkshopTimerCorner.css strips the pill's own background inside the corner
// (`.workshop-timer-corner .workshop-timer__summary { background: transparent }`)
// so the handle, pill and reset button read as one continuous bar rather than
// three separate boxes. That's where the running/not-running color has to be
// asserted for it to mean anything.
const pillBackground = (page: Page) =>
  page.getByTestId("workshop-timer-corner").evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe("workshop timer: Start closes the panel, color follows state, finish is loud", () => {
  let drawingId: string;

  test.beforeEach(async ({ request }) => {
    const drawing = await createDrawing(request, { name: `e2e-timer-signal-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async ({ request }) => {
    if (drawingId) await deleteDrawing(request, drawingId).catch(() => {});
  });

  test("Start collapses the panel immediately -- no second click needed", async ({ page }) => {
    await openEditor(page, drawingId);
    await summary(page).click();
    await expect(panel(page)).toBeVisible();

    await page.getByRole("button", { name: /^start$/i }).click();

    // No further interaction between Start and this assertion.
    await expect(panel(page)).toHaveCount(0);
    await expect(summary(page)).toContainText(/\d\d:\d\d/);
  });

  test("Pause/Resume/Stop leave the panel open -- only Start auto-closes it", async ({ page }) => {
    await openEditor(page, drawingId);
    await summary(page).click();
    await page.getByRole("button", { name: /^start$/i }).click();
    await expect(panel(page)).toHaveCount(0);

    await summary(page).click();
    await expect(panel(page)).toBeVisible();
    await page.getByRole("button", { name: /pause/i }).click();
    await expect(panel(page)).toBeVisible();
  });

  test("the pill's computed background switches with run state, not just its class", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    const idleColor = await pillBackground(page);

    await summary(page).click();
    await page.getByRole("button", { name: /^start$/i }).click();
    // Same socket round trip as the pause below (server decides, then
    // broadcasts back): the class landing is the signal that the *running*
    // snapshot has arrived, not merely that the click fired. Reading the
    // colour straight after the click raced that round trip and compared the
    // still-idle pill against itself -- red in CI, green locally, because the
    // round trip is faster on a quiet machine.
    await expect(page.locator(".workshop-timer--running")).toHaveCount(1);
    const runningColor = await pillBackground(page);
    expect(runningColor).not.toBe(idleColor);

    await summary(page).click();
    await page.getByRole("button", { name: /pause/i }).click();
    // The command is a socket round trip (server decides, then broadcasts
    // back) -- the badge appearing is the signal that the paused snapshot
    // has actually landed, not just that the click fired.
    await expect(page.locator(".workshop-timer__badge")).toContainText("Paused");
    const pausedColor = await pillBackground(page);
    expect(pausedColor).not.toBe(runningColor);
    expect(pausedColor).toBe(idleColor);
  });

  test("a timer running out is visible to everyone in the room, not just the one who started it", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    await openEditor(host, drawingId);
    await openEditor(guest, drawingId);

    const guestIdleColor = await pillBackground(guest);

    await summary(host).click();
    await host.locator(".workshop-timer input").fill("1");
    await host.getByRole("button", { name: /^start$/i }).click();

    await expect(summary(host)).toContainText(/00:5\d|01:00/);
    await expect(summary(guest)).toContainText(/00:5\d|01:00/);

    // The server, not the client, decides when it's over (socketWorkshopTimer.ts)
    // -- waiting for the guest's own DOM is what proves the room-wide broadcast,
    // not just the host's local countdown reaching zero.
    await expect(guest.locator('[data-timer-status="finished"]')).toBeVisible({
      timeout: 90_000,
    });
    await expect(summary(guest)).toContainText(/time's up/i);
    const guestFinishedColor = await pillBackground(guest);
    expect(guestFinishedColor).toBe(guestIdleColor);

    await expect(host.locator('[data-timer-status="finished"]')).toBeVisible();
    await expect(summary(host)).toContainText(/time's up/i);

    await hostCtx.close();
    await guestCtx.close();
  });

  test("a reconnect after the timer already finished does not replay the chime (Hans-Friedrich, PR #148)", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    // A real AudioContext stub instead of a product-code hook: playing a
    // chime creates two oscillators (workshopTimerChime.ts's two-tone
    // `playTone` calls) and calls `.start()` on each -- counting those calls
    // is an observable, from-the-outside proxy for "the chime played",
    // without adding a test-only seam to the shipped code.
    await page.addInitScript(() => {
      (window as unknown as { __chimeStarts: number[] }).__chimeStarts = [];
      class FakeAudioContext {
        currentTime = 0;
        destination = {};
        state = "running";
        resume() {
          return Promise.resolve();
        }
        createGain() {
          return {
            gain: {
              setValueAtTime() {},
              linearRampToValueAtTime() {},
              exponentialRampToValueAtTime() {},
            },
            connect() {},
          };
        }
        createOscillator() {
          return {
            type: "sine",
            frequency: { value: 0 },
            connect() {},
            start: () => {
              (window as unknown as { __chimeStarts: number[] }).__chimeStarts.push(Date.now());
            },
            stop() {},
          };
        }
      }
      (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    });

    await openEditor(page, drawingId);
    const chimeStartCount = () =>
      page.evaluate(() => (window as unknown as { __chimeStarts: number[] }).__chimeStarts.length);

    await summary(page).click();
    await page.locator(".workshop-timer input").fill("1");
    await page.getByRole("button", { name: /^start$/i }).click();
    expect(await chimeStartCount()).toBe(0);

    await expect(page.locator('[data-timer-status="finished"]')).toBeVisible({
      timeout: 90_000,
    });
    // Two oscillators per chime (workshopTimerChime.ts's two-tone playTone
    // calls) -- one real chime, not zero and not more than one.
    expect(await chimeStartCount()).toBe(2);

    // A real disconnect/reconnect, not a simulated event: dropping the
    // browser context offline forces socket.io to actually disconnect, and
    // useEditorCollaboration.ts's resetConnectionState() -> workshopTimer.reset()
    // runs on that real event -- exactly the path Hans-Friedrich's finding
    // named, not a hand-crafted stand-in for it.
    await page.context().setOffline(true);
    await page.waitForTimeout(1_000);
    await page.context().setOffline(false);

    // Give the rejoin's fresh "finished" snapshot (socket.ts's join handler)
    // time to arrive and for a regression to have played a second chime.
    await page.waitForTimeout(3_000);
    expect(await chimeStartCount()).toBe(2);
  });
});
