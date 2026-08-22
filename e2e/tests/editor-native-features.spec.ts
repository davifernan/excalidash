import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

/**
 * Two Excalidraw features we do not implement ourselves — we only have to stay
 * out of their way. Both were switched off by accident for a long time, so they
 * are worth a test that fails loudly if the editor chrome ever swallows them
 * again.
 */
test.describe("Excalidraw features we merely have to leave alone", () => {
  const openEditor = async (page: Page, id: string) => {
    await page.goto(`/editor/${id}`);
    await page.waitForSelector(".excalidraw", { timeout: 30000 });
    await page.waitForTimeout(2000);
  };

  test("Ctrl+F opens the canvas text search", async ({ page, request }) => {
    const drawing = await createDrawing(request, { name: "Native Search" });
    await openEditor(page, drawing.id);

    // handleKeyboardGlobally is off, so the shortcut only reaches Excalidraw
    // when the canvas itself holds focus.
    await page.locator(".excalidraw__canvas.interactive").click({ position: { x: 600, y: 400 } });
    await page.keyboard.press("Control+f");

    const search = page.locator('input[placeholder="Find text on canvas..."]');
    await expect(search).toBeVisible({ timeout: 5000 });

    await deleteDrawing(request, drawing.id);
  });

  test("offers one outer laser pointer with its shortcut even when alone", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: "Native Laser" });

    const alone = await browser.newContext();
    const pageA = await alone.newPage();
    await openEditor(pageA, drawing.id);

    const outerLaser = pageA.locator('[data-testid="toolbar-LaserPointer"]');
    await expect(outerLaser).toBeVisible();
    await expect(outerLaser).toHaveAttribute("aria-label", /K/);
    await expect(outerLaser).toHaveAttribute("aria-keyshortcuts", "K");

    await pageA.locator('.App-toolbar [data-testid="dropdown-menu-button"]').click();
    await expect(pageA.locator('[data-testid="toolbar-laser"]')).toBeHidden();
    await pageA.keyboard.press("Escape");
    await pageA.locator(".excalidraw__canvas.interactive").click({ position: { x: 600, y: 400 } });
    await pageA.keyboard.press("k");
    await expect(outerLaser).toBeChecked();

    await alone.close();
    await deleteDrawing(request, drawing.id);
  });

  test("keeps the board-title back button without repeating it in the main menu", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: "Single Back Route" });
    await openEditor(page, drawing.id);

    await expect(page.getByTestId("editor-back")).toBeVisible();
    await page.getByTestId("main-menu-trigger").click();
    await expect(page.getByText("Back to dashboard", { exact: true })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await page.getByTestId("editor-back").click();
    await expect(page).toHaveURL(/\/$/);

    await deleteDrawing(request, drawing.id);
  });

  test("keeps one mobile back route when the board-title island stands down", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: "Mobile Back Route" });
    await page.setViewportSize({ width: 390, height: 844 });
    await openEditor(page, drawing.id);

    await expect(page.getByTestId("editor-back")).toHaveCount(0);
    await page.getByTestId("main-menu-trigger").click();
    await expect(page.getByText("Back to dashboard", { exact: true })).toBeVisible();

    await deleteDrawing(request, drawing.id);
  });
});
