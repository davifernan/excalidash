import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

/**
 * A picture of the finished thing.
 *
 * The assertions elsewhere say the numbers are right. This one exists so a
 * person can look at the board and see whether it reads as paper — which no
 * assertion covers and which is the whole point of the feature.
 */
test("a board full of notes", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  const drawing = await createDrawing(request, { name: `e2e-sticky-visual-${Date.now()}` });

  try {
    await page.goto(`/editor/${drawing.id}`);
    await page.waitForSelector("canvas");
    await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);

    const notes: Array<[string, string, { x: number; y: number }]> = [
      ["Yellow", "Ship the sticky notes", { x: 260, y: 220 }],
      ["Blue", "Excalidraw grows the box; a note has to keep its size instead", { x: 500, y: 220 }],
      ["Green", "Done", { x: 740, y: 220 }],
      ["Pink", "Tab", { x: 260, y: 460 }],
      ["Orange", "Six colours, so a wall of notes can still be grouped by eye", { x: 500, y: 460 }],
      ["Grey", "Parked", { x: 740, y: 460 }],
    ];

    for (const [colour, text, at] of notes) {
      await page.getByTestId("toolbar-sticky").click();
      await page.waitForFunction(
        () =>
          (window as any).__EXCALIDASH_TEST__.getAppState().activeTool
            ?.customType === "sticky",
      );
      await page.locator("canvas").last().click({ position: at });
      await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
      await page.keyboard.type(text);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await page.locator("canvas").last().click({ position: at });
      await expect(page.getByRole("toolbar", { name: "Note colour" })).toBeVisible();
      await page.getByRole("button", { name: colour, exact: true }).click();
      await page.waitForTimeout(200);
    }

    await page.mouse.click(1100, 640);
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/sticky-notes.png", fullPage: false });

    // The selected note, with its viewport-sized colour toolbar.
    await page
      .locator("canvas")
      .last()
      .click({ position: { x: 740, y: 460 } });
    await expect(page.getByRole("toolbar", { name: "Note colour" })).toBeVisible();
    await page.screenshot({ path: "test-results/sticky-toolbar.png", fullPage: false });

    // And the points a note offers for pulling an arrow out of it.
    const first = await page.locator("canvas").last().boundingBox();
    await page.mouse.move(first!.x + 260, first!.y + 220);
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/sticky-handles.png", clip: { x: 120, y: 60, width: 420, height: 380 } });

    const placed = await page.evaluate(() =>
      (window as any).__EXCALIDASH_TEST__
        .getSceneElements()
        .filter((element: any) => element.customData?.excalidash?.sticky)
        .map((element: any) => ({ w: element.width, h: element.height })),
    );
    expect(placed).toHaveLength(6);
    // Every one of them still the size it started as, long text or not.
    expect(placed.every((n: any) => n.w === 200 && n.h === 200)).toBe(true);
  } finally {
    await deleteDrawing(request, drawing.id).catch(() => {});
  }
});
