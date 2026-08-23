import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor as openEditorReady } from "./helpers/editor";

/**
 * Two Excalidraw features we do not implement ourselves — we only have to stay
 * out of their way. Both were switched off by accident for a long time, so they
 * are worth a test that fails loudly if the editor chrome ever swallows them
 * again.
 */
test.describe("Excalidraw features we merely have to leave alone", () => {
  const openEditor = (page: Page, id: string) => openEditorReady(page, id, { settleMs: 2000 });

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

  /**
   * Superseded by NIL-374/NIL-376: this used to assert the opposite -- that
   * Excalidraw hides its standalone laser toggle until it believes a second
   * person is on the board. That was the bug (Davi: "der laser pointer ist
   * jetzt auch doppelt"), not a feature to leave alone. `isCollaborating` is
   * now a constant `true` (EditorView.tsx) specifically so this control
   * exists in every state, and the extra-tools flyout that used to be the
   * only route to it while alone is hidden as the duplicate
   * (editorChrome.css). canvas-chrome.spec.ts covers the K hint and arming
   * the tool; this one keeps the cross-context shape of the original.
   */
  test("the laser pointer is available immediately, alone or with company", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: "Native Laser" });

    const laserOffered = async (page: Page) => (await page.getByTestId("toolbar-LaserPointer").count()) > 0;
    const flyoutLaserHidden = async (page: Page) => {
      await page.locator(".App-toolbar__extra-tools-trigger").click();
      const hidden = await page.getByTestId("toolbar-laser").isHidden();
      await page.keyboard.press("Escape");
      return hidden;
    };

    const alone = await browser.newContext();
    const pageA = await alone.newPage();
    await openEditor(pageA, drawing.id);
    expect(await laserOffered(pageA)).toBe(true);
    expect(await flyoutLaserHidden(pageA)).toBe(true);

    const second = await browser.newContext();
    const pageB = await second.newPage();
    await openEditor(pageB, drawing.id);
    await pageA.waitForTimeout(1000);
    expect(await laserOffered(pageA)).toBe(true);

    await alone.close();
    await second.close();
    await deleteDrawing(request, drawing.id);
  });
});
