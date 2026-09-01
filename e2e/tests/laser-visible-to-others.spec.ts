import { expect, test } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * The half of the laser pointer nobody could see.
 *
 * Reported as "I see it myself, the others do not", which is exactly what the
 * code did: the tool travelled the whole way -- the server even refuses a
 * cursor payload without it -- and was dropped on arrival, so a remote laser
 * arrived as an ordinary cursor.
 *
 * Asserted on the OBSERVER's side, through the collaborator record the editor
 * actually draws from. A screenshot of a canvas trail alone would be a picture
 * of something nobody checked; this checks the thing that makes the trail
 * appear, and attaches the picture too.
 */
test.describe("a laser pointer reaches the other people on the board", () => {
  test("the observer's collaborator record carries the laser tool", async ({
    browser,
    request,
  }, testInfo) => {
    const drawing = await createDrawing(request, { name: `laser-${Date.now()}` });
    const holderContext = await browser.newContext();
    const observerContext = await browser.newContext();

    try {
      const holder = await holderContext.newPage();
      const observer = await observerContext.newPage();
      await openEditor(holder, drawing.id, { settleMs: 800 });
      await openEditor(observer, drawing.id, { settleMs: 800 });

      // Arm the laser and move across the canvas, so a pointer update with
      // tool "laser" is what goes out.
      await holder.keyboard.press("k");
      const canvas = holder.locator("canvas.excalidraw__canvas.interactive");
      const box = await canvas.boundingBox();
      if (!box) throw new Error("interactive canvas is not available");
      await holder.mouse.move(box.x + 260, box.y + 200);
      await holder.mouse.down();
      for (let step = 1; step <= 12; step += 1) {
        await holder.mouse.move(box.x + 260 + step * 30, box.y + 200 + step * 12);
        await holder.waitForTimeout(60);
      }
      await holder.mouse.up();

      await expect
        .poll(
          async () =>
            observer.evaluate(() => {
              const harness = (window as any).__EXCALIDASH_TEST__;
              const peers = harness?.getAppState?.()?.collaborators;
              if (!peers) return null;
              return [...peers.values()].map((peer: any) => peer.pointerTool ?? null);
            }),
          { timeout: 15_000, message: "the observer never saw a laser pointer" },
        )
        .toContain("laser");

      const shot = testInfo.outputPath("laser-seen-by-the-other-side.png");
      await observer.screenshot({ path: shot });
      await testInfo.attach("laser-seen-by-the-other-side", {
        path: shot,
        contentType: "image/png",
      });
    } finally {
      await holderContext.close();
      await observerContext.close();
      await deleteDrawing(request, drawing.id).catch(() => undefined);
    }
  });
});
