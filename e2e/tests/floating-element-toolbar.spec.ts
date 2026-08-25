import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { activateDocumentWidget, dropMarkdown, openEditor } from "./helpers/editor";

const MARKDOWN = Array.from(
  { length: 40 },
  (_, index) => `## Section ${index + 1}\n\n${`Toolbar body ${index + 1}. `.repeat(30)}\n`,
).join("\n");

const setZoom = async (page: import("@playwright/test").Page, zoom: number) => {
  await page.evaluate((value) => {
    (window as any).__EXCALIDASH_TEST__.updateScene({ appState: { zoom: { value } } });
  }, zoom);
  await page.waitForTimeout(250);
};

test("document controls stay viewport-sized and visible at the top edge", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: `Floating toolbar ${Date.now()}` });

  try {
    await openEditor(page, drawing.id, { settleMs: 500 });
    await dropMarkdown(page, MARKDOWN, "workshop-notes.md");
    await expect(page.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await activateDocumentWidget(page);

    const toolbar = page.getByRole("toolbar", { name: "Document controls" });
    await expect(toolbar).toBeVisible();

    const measurements: Array<{
      zoom: number;
      toolbar: { width: number; height: number };
      element: { width: number; height: number };
    }> = [];
    for (const zoom of [0.5, 1, 2]) {
      await setZoom(page, zoom);
      const toolbarBox = await toolbar.boundingBox();
      const elementBox = await page.locator(".text-document-widget").boundingBox();
      expect(toolbarBox).not.toBeNull();
      expect(elementBox).not.toBeNull();
      measurements.push({
        zoom,
        toolbar: { width: toolbarBox!.width, height: toolbarBox!.height },
        element: { width: elementBox!.width, height: elementBox!.height },
      });
      await page.screenshot({
        path: `test-results/floating-toolbar-${Math.round(zoom * 100)}.png`,
        fullPage: false,
      });
    }

    expect(measurements[1].element.width / measurements[0].element.width).toBeCloseTo(2, 2);
    expect(measurements[2].element.width / measurements[1].element.width).toBeCloseTo(2, 2);
    expect(new Set(measurements.map(({ toolbar: box }) => Math.round(box.width))).size).toBe(1);
    expect(new Set(measurements.map(({ toolbar: box }) => Math.round(box.height))).size).toBe(1);
    console.log(`NIL-565 zoom measurements: ${JSON.stringify(measurements)}`);

    await page.getByRole("button", { name: "Rename workshop-notes.md" }).click();
    const filename = page.getByRole("textbox", { name: "Document filename" });
    await filename.fill("workshop-agenda.md");
    await filename.press("Enter");
    await expect(page.getByRole("button", { name: "Rename workshop-agenda.md" })).toBeVisible();

    await page.reload();
    await page.waitForSelector("canvas");
    await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
    await expect(page.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await activateDocumentWidget(page);
    await expect(page.getByRole("button", { name: "Rename workshop-agenda.md" })).toBeVisible();
    await page.screenshot({
      path: "test-results/floating-toolbar-renamed.png",
      fullPage: false,
    });

    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const elements = api.getSceneElements();
      api.updateScene({
        elements: elements.map((element: any) =>
          element.type === "embeddable" ? { ...element, y: -20 } : element,
        ),
        appState: { zoom: { value: 1 }, scrollY: 0 },
      });
    });
    await page.waitForTimeout(250);
    await expect(toolbar).toBeVisible();
    const rootBox = await page.locator(".excalidraw").boundingBox();
    const topEdgeBox = await toolbar.boundingBox();
    expect(topEdgeBox!.y).toBeGreaterThanOrEqual(rootBox!.y + 8);
    await page.screenshot({ path: "test-results/floating-toolbar-top-edge.png", fullPage: false });

    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const [widget] = api.getSceneElements();
      const copy = { ...widget, id: `${widget.id}-copy`, x: widget.x + widget.width + 40 };
      api.updateScene({
        elements: [widget, copy],
        appState: { selectedElementIds: { [widget.id]: true, [copy.id]: true } },
      });
    });
    await expect(toolbar).toHaveCount(0);
  } finally {
    await deleteDrawing(request, drawing.id).catch(() => {});
  }
});
