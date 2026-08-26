import { expect, test, type Page } from "@playwright/test";
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

const dropOnePagePdf = (page: Page) =>
  page.evaluate(() => {
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      "<< /Length 43 >>\nstream\nBT /F1 24 Tf 72 720 Td (NIL-607 PDF) Tj ET\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("");
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    const target = document.querySelector<HTMLElement>(".excalidraw")?.closest("div[style]");
    if (!target) throw new Error("Editor drop target missing");
    const transfer = new DataTransfer();
    transfer.items.add(new File([pdf], "stacking-proof.pdf", { type: "application/pdf" }));
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  });

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
    await dropOnePagePdf(page);
    await expect(page.locator(".pdf-widget")).toHaveCount(1, { timeout: 30_000 });

    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const elements = api.getSceneElements();
      const widgets = elements.filter((element: any) => element.type === "embeddable");
      const markdown = widgets.find(
        (element: any) => element.customData?.excalidash?.widget?.kind === "markdown",
      );
      const pdf = widgets.find(
        (element: any) => element.customData?.excalidash?.widget?.kind === "pdf",
      );
      if (!markdown || !pdf) throw new Error("Expected Markdown and PDF widgets");
      const shared = { x: 360, y: 100, width: 520, height: 560 };
      api.updateScene({
        elements: elements.map((element: any) =>
          element.id === markdown.id || element.id === pdf.id ? { ...element, ...shared } : element,
        ),
        appState: { selectedElementIds: { [markdown.id]: true } },
      });
    });
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
