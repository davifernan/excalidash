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
  // Two full editors in two contexts, both loaded before the first gesture.
  // The default 60s budget was not enough under CI load and the run died in
  // teardown, which reads like a product failure and is not one.
  test.setTimeout(120_000);

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
      // Loaded together rather than one after the other: they are independent,
      // and doing them in sequence spent most of the budget before the test
      // had done anything.
      await Promise.all([
        openEditor(holder, drawing.id, { settleMs: 800 }),
        openEditor(observer, drawing.id, { settleMs: 800 }),
      ]);

      // Armed through the toolbar button, not the "k" shortcut. The first
      // version of this spec pressed the key and the observer reported
      // "pointer" -- which proved the plumbing worked and the test did not.
      // The button is this application's own control (the native laser island
      // is hidden), so clicking it is also what a person does.
      // Scoped to the toolbar: Excalidraw's own laser control carries the same
      // test id and is only hidden by CSS, so an unscoped lookup matches two
      // elements. This application's button is the one portalled into
      // `.App-toolbar`.
      await holder.locator(".App-toolbar").getByTestId("toolbar-LaserPointer").click();
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
