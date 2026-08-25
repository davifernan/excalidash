import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { activateDocumentWidget, dropMarkdown, openEditor } from "./helpers/editor";

const MARKDOWN = Array.from(
  { length: 40 },
  (_, index) => `## Section ${index + 1}\n\n${`Toolbar body ${index + 1}. `.repeat(30)}\n`,
).join("\n");

const LONG_FILENAME =
  "workshop-agenda-for-quarterly-planning-with-research-decisions-and-follow-ups.md";

type Box = { x: number; y: number; width: number; height: number };

const overlapArea = (first: Box, second: Box) => {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  return width * height;
};

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
    await expect(page.getByText("workshop-notes.md added", { exact: false })).toBeHidden({
      timeout: 10_000,
    });

    const measurements: Array<{
      zoom: number;
      placement: string | null;
      toolbar: { width: number; height: number };
      previousButton: { width: number; height: number };
      element: { width: number; height: number };
      toolbarIslandOverlap: number;
      elementOverlap: number;
    }> = [];
    for (const zoom of [0.5, 1, 2]) {
      await setZoom(page, zoom);
      const toolbarBox = await toolbar.boundingBox();
      const elementBox = await page.locator(".text-document-widget").boundingBox();
      const toolbarIslandBox = await page.locator(".App-toolbar").boundingBox();
      const previousButtonBox = await page
        .getByRole("button", { name: "Previous page" })
        .boundingBox();
      expect(toolbarBox).not.toBeNull();
      expect(elementBox).not.toBeNull();
      expect(toolbarIslandBox).not.toBeNull();
      expect(previousButtonBox).not.toBeNull();
      const placement = await toolbar.getAttribute("data-placement");
      const toolbarIslandOverlap = overlapArea(toolbarBox!, toolbarIslandBox!);
      const elementOverlap = overlapArea(toolbarBox!, elementBox!);
      measurements.push({
        zoom,
        placement,
        toolbar: { width: toolbarBox!.width, height: toolbarBox!.height },
        previousButton: { width: previousButtonBox!.width, height: previousButtonBox!.height },
        element: { width: elementBox!.width, height: elementBox!.height },
        toolbarIslandOverlap,
        elementOverlap,
      });
      console.log(
        `NIL-573 zoom ${zoom}: ${JSON.stringify({ placement, toolbarBox, elementBox, toolbarIslandBox, toolbarIslandOverlap, elementOverlap })}`,
      );
      expect(toolbarIslandOverlap).toBe(0);
      expect(elementOverlap).toBe(0);
      await page.screenshot({
        path: `test-results/floating-toolbar-${Math.round(zoom * 100)}.png`,
        fullPage: false,
      });
    }

    expect(measurements[1].element.width / measurements[0].element.width).toBeCloseTo(2, 2);
    expect(measurements[2].element.width / measurements[1].element.width).toBeCloseTo(2, 2);
    expect(
      new Set(measurements.map(({ previousButton }) => Math.round(previousButton.width))).size,
    ).toBe(1);
    expect(
      new Set(measurements.map(({ previousButton }) => Math.round(previousButton.height))).size,
    ).toBe(1);
    expect(measurements[0].placement).toBe("above");
    expect(measurements[1].placement).toBe("below");
    expect(measurements[2].placement).toBe("right");
    expect(measurements[1].elementOverlap).toBe(0);
    console.log(`NIL-573 zoom measurements: ${JSON.stringify(measurements)}`);

    await page.getByRole("button", { name: "Rename workshop-notes.md" }).click();
    const filename = page.getByRole("textbox", { name: "Document filename" });
    await filename.fill(LONG_FILENAME);
    await filename.press("Enter");
    const renamedButton = page.getByRole("button", { name: `Rename ${LONG_FILENAME}` });
    await expect(renamedButton).toBeVisible();
    const filenameMetrics = await renamedButton.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textOverflow: getComputedStyle(element).textOverflow,
    }));
    expect(filenameMetrics.scrollWidth).toBeGreaterThan(filenameMetrics.clientWidth);
    expect(filenameMetrics.textOverflow).toBe("ellipsis");
    const toolbarOverflow = await toolbar.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(toolbarOverflow.scrollWidth).toBeLessThanOrEqual(toolbarOverflow.clientWidth);
    expect(toolbarOverflow.overflowX).toBe("hidden");

    await page.reload();
    await page.waitForSelector("canvas");
    await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
    await expect(page.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await activateDocumentWidget(page);
    await expect(page.getByRole("button", { name: `Rename ${LONG_FILENAME}` })).toBeVisible();
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
    const topEdgeBox = await toolbar.boundingBox();
    const topEdgeElementBox = await page.locator(".text-document-widget").boundingBox();
    const topEdgeIslandBox = await page.locator(".App-toolbar").boundingBox();
    expect(await toolbar.getAttribute("data-placement")).toBe("below");
    expect(overlapArea(topEdgeBox!, topEdgeElementBox!)).toBe(0);
    expect(overlapArea(topEdgeBox!, topEdgeIslandBox!)).toBe(0);
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
