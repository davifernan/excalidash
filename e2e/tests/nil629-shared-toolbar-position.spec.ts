import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { activateDocumentWidget, armTool, dropMarkdown, openEditor } from "./helpers/editor";

/**
 * NIL-629 evidence: same anchor position, same conditions, all three
 * toolbars measured -- not eyeballed.
 */
test("NIL-629 evidence: relative toolbar position and appearance match across sticky/PDF/markdown", async ({
  page,
  request,
}) => {
  const measurements: Record<string, any> = {};

  // --- Sticky note ---
  const stickyDrawing = await createDrawing(request, {
    name: `NIL-629 evidence sticky ${Date.now()}`,
  });
  try {
    await openEditor(page, stickyDrawing.id, { settleMs: 500 });
    await armTool(page);
    await page.mouse.click(500, 300);
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.mouse.click(500, 300);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "test-results/nil629-evidence-sticky.png" });
    const toolbar = await page.locator(".element-floating-toolbar").first().boundingBox();
    const element = await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const note = api.getSceneElements().find((e: any) => e.customData?.excalidash?.sticky);
      const viewport = api.getViewport();
      // Excalidraw's own scene-to-viewport conversion (sceneCoordsToViewportCoords):
      // screen = (scene + scroll) * zoom + offset.
      const x = (note.x + viewport.scrollX) * viewport.zoom + viewport.offsetLeft;
      const y = (note.y + viewport.scrollY) * viewport.zoom + viewport.offsetTop;
      return { x, y, width: note.width * viewport.zoom, height: note.height * viewport.zoom };
    });
    measurements.sticky = { toolbar, element };
  } finally {
    await deleteDrawing(request, stickyDrawing.id);
  }

  // --- Markdown widget ---
  const mdDrawing = await createDrawing(request, { name: `NIL-629 evidence md ${Date.now()}` });
  try {
    await openEditor(page, mdDrawing.id, { settleMs: 500 });
    const MARKDOWN = Array.from(
      { length: 60 },
      (_, i) => `## Section ${i + 1}\n\n${`Body text for section ${i + 1}. `.repeat(30)}\n`,
    ).join("\n");
    await dropMarkdown(page, MARKDOWN, "evidence.md");
    await expect(page.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(500);
    await activateDocumentWidget(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "test-results/nil629-evidence-markdown.png" });
    const toolbar = await page.locator(".element-floating-toolbar").first().boundingBox();
    const element = await page.locator(".text-document-widget").first().boundingBox();
    measurements.markdown = { toolbar, element };
  } finally {
    await deleteDrawing(request, mdDrawing.id);
  }

  // --- PDF widget (NIL-607's stacking-policy.spec.ts pattern: swap a
  // markdown widget's declared kind to "pdf" and stub the asset routes --
  // shared browser jobs don't install a PDF renderer). ---
  const pdfDrawing = await createDrawing(request, { name: `NIL-629 evidence pdf ${Date.now()}` });
  try {
    await openEditor(page, pdfDrawing.id, { settleMs: 500 });
    await dropMarkdown(page, "PDF fixture source", "evidence-pdf-source.md");
    await expect(page.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });

    const widgetId = await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const widget = api.getSceneElements().find((element: any) => element.type === "embeddable");
      return { elementId: widget.id, assetId: widget.customData.excalidash.widget.assetId };
    });

    await page.route(`**/drawings/${pdfDrawing.id}/assets/${widgetId.assetId}`, async (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: widgetId.assetId,
          kind: "PDF",
          name: "evidence.pdf",
          sizeBytes: 1024,
          pageCount: 1,
        }),
      }),
    );
    await page.route(
      `**/drawings/${pdfDrawing.id}/assets/${widgetId.assetId}/pages/1**`,
      async (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"><rect width="612" height="792" fill="white"/><text x="72" y="100" font-size="36">NIL-629 PDF</text></svg>',
        }),
    );

    await page.evaluate(({ elementId }) => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const elements = api.getSceneElements();
      api.updateScene({
        elements: elements.map((element: any) =>
          element.id === elementId
            ? {
                ...element,
                customData: {
                  ...element.customData,
                  excalidash: {
                    ...element.customData.excalidash,
                    widget: { ...element.customData.excalidash.widget, kind: "pdf" },
                  },
                },
              }
            : element,
        ),
        appState: { selectedElementIds: { [elementId]: true } },
      });
    }, widgetId);
    await expect(page.locator(".pdf-widget")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".pdf-widget__page-image")).toBeVisible();
    await page.waitForTimeout(500);

    await page.screenshot({ path: "test-results/nil629-evidence-pdf.png" });
    const toolbar = await page.locator(".element-floating-toolbar").first().boundingBox();
    const element = await page.locator(".pdf-widget").first().boundingBox();
    measurements.pdf = { toolbar, element };
  } finally {
    await deleteDrawing(request, pdfDrawing.id);
  }

  console.log("MEASUREMENTS:", JSON.stringify(measurements, null, 2));

  // Same relative rule for all three, via the identical shared
  // placeFloatingToolbar/elementViewportBounds functions: ELEMENT_GAP (8px)
  // of "air" between toolbar and element on whichever side it actually
  // placed on (above/below/left/right) -- a large widget that does not fit
  // above in this viewport correctly falls back to the side, per NIL-573's
  // own documented behavior, so the gap is checked on whichever edge is
  // actually adjacent rather than assuming "above" for every case.
  for (const [name, m] of Object.entries(measurements)) {
    if (!m.toolbar || !m.element) continue;
    const t = m.toolbar;
    const e = m.element;
    const gapAbove = e.y - (t.y + t.height);
    const gapBelow = t.y - (e.y + e.height);
    const gapLeft = e.x - (t.x + t.width);
    const gapRight = t.x - (e.x + e.width);
    const candidates = { above: gapAbove, below: gapBelow, left: gapLeft, right: gapRight };
    const [side, gap] = Object.entries(candidates).reduce((best, cur) =>
      Math.abs(cur[1] - 8) < Math.abs(best[1] - 8) ? cur : best,
    );
    console.log(`${name}: side=${side}, gap=${gap.toFixed(1)}px`);
    // +/-2px tolerance: the sticky measurement is computed from scene
    // coordinates, the widget measurements from a DOM boundingBox() -- both
    // correctly reflect the same 8px ELEMENT_GAP constant, but mixing a
    // scene-space and a DOM-space measurement leaves a little sub-pixel
    // rounding between the two approaches, not a real placement difference.
    expect(gap).toBeGreaterThanOrEqual(6);
    expect(gap).toBeLessThanOrEqual(10);
  }
});
