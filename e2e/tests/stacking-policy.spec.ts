import { expect, test } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { dropMarkdown, openEditor } from "./helpers/editor";

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

test("semantic layers keep context menus, element content, frames, and dialogs together", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: `Stacking policy ${Date.now()}` });

  try {
    await openEditor(page, drawing.id, { settleMs: 500 });

    await page.getByTestId("main-menu-trigger").click();
    await page
      .locator('[data-testid="dropdown-menu"]')
      .getByText("Comments", { exact: true })
      .click();
    const commentPanel = page.getByTestId("comment-panel");
    await expect(commentPanel).toBeVisible();

    const canvas = page.locator(".excalidraw__canvas.interactive");
    const canvasBox = await canvas.boundingBox();
    const panelBox = await commentPanel.boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    await page.mouse.click(panelBox!.x - 18, panelBox!.y + 180, { button: "right" });
    const contextMenu = page.locator(".context-menu");
    await expect(contextMenu).toBeVisible();
    const menuBox = await contextMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    const menuPanelOverlap = overlapArea(menuBox!, panelBox!);
    expect(menuPanelOverlap).toBeGreaterThan(0);
    const overlapWinner = await page.evaluate(
      ({ menu, panel }) => {
        const left = Math.max(menu.x, panel.x);
        const right = Math.min(menu.x + menu.width, panel.x + panel.width);
        const top = Math.max(menu.y, panel.y);
        const bottom = Math.min(menu.y + menu.height, panel.y + panel.height);
        const winner = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return {
          className: winner instanceof HTMLElement ? winner.className : "",
          isContextMenu: Boolean(winner?.closest(".context-menu")),
        };
      },
      { menu: menuBox!, panel: panelBox! },
    );
    console.log(
      `NIL-607 comment/menu overlap: ${JSON.stringify({ menuPanelOverlap, overlapWinner })}`,
    );
    await page.screenshot({ path: "test-results/nil-607-context-menu-over-comments.png" });
    expect(overlapWinner.isContextMenu).toBe(true);

    await page.keyboard.press("Escape");
    await page.getByTestId("comment-panel-close").click();
    await dropMarkdown(page, "# Markdown on top\n\nThe selected document must cover the PDF.");
    await expect(page.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    // The shared browser jobs deliberately do not install Poppler; PDF decode
    // belongs to backend risk coverage. Reuse a stored document id, switch its
    // canvas element to the PDF kind, and stub only metadata/page bytes. This
    // still mounts the real PdfWidget and Excalidraw embeddable container whose
    // stacking contract this frontend test measures.
    await dropMarkdown(page, "PDF page fixture", "stacking-proof-source.md");
    await expect(page.locator(".text-document-widget")).toHaveCount(2, { timeout: 30_000 });

    const widgetIds = await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const widgets = api
        .getSceneElements()
        .filter(
          (element: any) =>
            element.type === "embeddable" &&
            element.customData?.excalidash?.widget?.kind === "markdown",
        );
      if (widgets.length !== 2) throw new Error("Expected two document widgets");
      return {
        markdownElementId: widgets[0].id,
        pdfElementId: widgets[1].id,
        pdfAssetId: widgets[1].customData.excalidash.widget.assetId,
      };
    });
    await page.route(
      `**/api/drawings/${drawing.id}/assets/${widgetIds.pdfAssetId}`,
      async (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            id: widgetIds.pdfAssetId,
            kind: "PDF",
            name: "stacking-proof.pdf",
            sizeBytes: 1024,
            pageCount: 1,
          }),
        }),
    );
    await page.route(
      `**/api/drawings/${drawing.id}/assets/${widgetIds.pdfAssetId}/pages/1**`,
      async (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"><rect width="612" height="792" fill="white"/><text x="72" y="100" font-size="36">NIL-607 PDF</text></svg>',
        }),
    );

    await page.evaluate(({ markdownElementId, pdfElementId }) => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const elements = api.getSceneElements();
      const markdown = elements.find((element: any) => element.id === markdownElementId);
      const pdf = elements.find((element: any) => element.id === pdfElementId);
      if (!markdown || !pdf) throw new Error("Expected Markdown and PDF widgets");
      const shared = { x: 360, y: 100, width: 520, height: 560 };
      api.updateScene({
        elements: elements.map((element: any) => {
          if (element.id === markdown.id) return { ...element, ...shared };
          if (element.id !== pdf.id) return element;
          return {
            ...element,
            ...shared,
            customData: {
              ...element.customData,
              excalidash: {
                ...element.customData.excalidash,
                widget: { ...element.customData.excalidash.widget, kind: "pdf" },
              },
            },
          };
        }),
        appState: { selectedElementIds: { [markdown.id]: true } },
      });
    }, widgetIds);
    await expect(page.locator(".text-document-widget")).toHaveCount(1);
    await expect(page.locator(".pdf-widget")).toHaveCount(1);
    await expect(page.locator(".pdf-widget__page-image")).toBeVisible();
    await page.waitForTimeout(300);

    const markdownWidget = page.locator(".text-document-widget");
    const pdfWidget = page.locator(".pdf-widget");
    const markdownBox = await markdownWidget.boundingBox();
    const pdfBox = await pdfWidget.boundingBox();
    expect(markdownBox).not.toBeNull();
    expect(pdfBox).not.toBeNull();
    const widgetOverlap = overlapArea(markdownBox!, pdfBox!);
    expect(widgetOverlap).toBeGreaterThan(100_000);
    const widgetLayers = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".excalidraw");
      const markdown = document
        .querySelector<HTMLElement>(".text-document-widget")
        ?.closest<HTMLElement>(".excalidraw__embeddable-container");
      const pdf = document
        .querySelector<HTMLElement>(".pdf-widget")
        ?.closest<HTMLElement>(".excalidraw__embeddable-container");
      if (!root || !markdown || !pdf) throw new Error("Widget layer nodes missing");
      const rootStyle = getComputedStyle(root);
      return {
        markdown: getComputedStyle(markdown).zIndex,
        pdf: getComputedStyle(pdf).zIndex,
        selectedFrame: rootStyle.getPropertyValue("--zIndex-svgLayer").trim(),
        content: rootStyle.getPropertyValue("--zIndex-interactiveCanvas").trim(),
      };
    });
    expect(widgetLayers.markdown).toBe(widgetLayers.selectedFrame);
    expect(widgetLayers.pdf).toBe(widgetLayers.content);
    console.log(`NIL-607 widget overlap: ${JSON.stringify({ widgetOverlap, widgetLayers })}`);
    await page.screenshot({ path: "test-results/nil-607-markdown-over-pdf.png" });

    const toolbar = page.getByRole("toolbar", { name: "Document controls" });
    await expect(toolbar).toBeVisible();
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    await page.keyboard.press("Control+k");
    const commandDialog = page.getByRole("dialog", { name: "Search boards and commands" });
    await expect(commandDialog).toBeVisible();
    const dialogWins = await page.evaluate(
      ({ x, y }) => {
        const winner = document.elementFromPoint(x, y);
        return Boolean(
          winner?.closest('[role="dialog"], [data-testid="command-palette-backdrop"]'),
        );
      },
      { x: toolbarBox!.x + toolbarBox!.width / 2, y: toolbarBox!.y + toolbarBox!.height / 2 },
    );
    expect(dialogWins).toBe(true);
    await page.screenshot({ path: "test-results/nil-607-command-palette-over-toolbar.png" });
  } finally {
    await deleteDrawing(request, drawing.id).catch(() => {});
  }
});
