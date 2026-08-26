import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { armTool, openEditor } from "./helpers/editor";

/**
 * NIL-629 Nachweispflicht: the shared floating toolbar keeps its own
 * screen-pixel size at zoom 0.5/1/2, while the element under it grows --
 * the NIL-573 guarantee, now exercised through the shared component every
 * consumer renders through.
 */
test("shared floating toolbar keeps its screen size across zoom 0.5/1/2 (NIL-573)", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: `NIL-629 zoom ${Date.now()}` });
  try {
    await openEditor(page, drawing.id, { settleMs: 500 });
    await armTool(page);
    await page.mouse.click(500, 300);
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.mouse.click(500, 300);
    await page.waitForTimeout(300);

    const sizes: Record<string, any> = {};
    for (const zoom of [0.5, 1, 2]) {
      await page.keyboard.press("Control+0");
      await page.waitForTimeout(150);
      if (zoom === 0.5) {
        await page.keyboard.press("Control+-");
        await page.keyboard.press("Control+-");
      } else if (zoom === 2) {
        await page.keyboard.press("Control+=");
        await page.keyboard.press("Control+=");
      }
      await page.waitForTimeout(300);
      await page.mouse.click(500, 300);
      await page.waitForTimeout(300);
      const toolbar = page.locator(".element-floating-toolbar").first();
      const box = await toolbar.boundingBox();
      const actualZoom = await page.evaluate(
        () => (window as any).__EXCALIDASH_TEST__.getViewport()?.zoom,
      );
      sizes[zoom] = { requestedZoom: zoom, actualZoom, box };
      await page.screenshot({ path: `test-results/nil629-zoom-${zoom}.png` });
    }
    console.log("SIZES:", JSON.stringify(sizes, null, 2));

    const widths = Object.values(sizes).map((s: any) => s.box?.width);
    const heights = Object.values(sizes).map((s: any) => s.box?.height);
    for (const w of widths) expect(Math.abs(w - widths[0])).toBeLessThanOrEqual(2);
    for (const h of heights) expect(Math.abs(h - heights[0])).toBeLessThanOrEqual(2);
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
