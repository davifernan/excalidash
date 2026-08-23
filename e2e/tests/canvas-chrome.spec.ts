import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * NIL-376: the hamburger carries the board name and the way back (the old
 * floating island is gone), Help is its last entry and Excalidraw's floating
 * "?" is hidden, the top-right cluster reads as one control group, and the
 * laser pointer has exactly one control, visible whether or not anyone else
 * is on the board.
 */

const openMenu = async (page: Page) => {
  await page.getByTestId("main-menu-trigger").click();
};

test.describe("the hamburger carries the board's identity and the way back", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-chrome-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("the board name is the first line, editable, and there is no floating island", async ({
    page,
  }) => {
    const drawing = await getDrawing(api, drawingId);
    await openEditor(page, drawingId);

    // The island this package removed used to live here, always visible.
    await expect(page.getByTestId("editor-top-left")).toHaveCount(0);

    await openMenu(page);
    const menuItems = page.locator('[data-testid="dropdown-menu"] .dropdown-menu-container > *');
    await expect(page.getByTestId("menu-board-name")).toBeVisible();
    await expect(page.getByTestId("menu-board-name")).toContainText(drawing.name);
    // The first item wraps our content in Excalidraw's own ItemCustom
    // container, so check containment rather than the testid directly.
    await expect(menuItems.first().getByTestId("menu-board-name")).toHaveCount(1);

    await page.getByTestId("menu-board-name").dblclick();
    const nameInput = page.getByLabel("Drawing name");
    await nameInput.fill("Renamed via menu");
    await nameInput.press("Enter");

    await expect.poll(async () => (await getDrawing(api, drawingId)).name).toBe(
      "Renamed via menu",
    );
  });

  test("back to dashboard sits directly under the name and returns home", async ({ page }) => {
    await openEditor(page, drawingId);
    await openMenu(page);

    const menuItems = page.locator('[data-testid="dropdown-menu"] .dropdown-menu-container > *');
    await expect(menuItems.nth(1)).toContainText("Back to dashboard");

    await page.getByText("Back to dashboard").click();
    await page.waitForURL("/");
    await expect(page.getByPlaceholder("Search drawings...")).toBeVisible();
  });

  test("Help is the last entry, and the floating question mark is gone", async ({ page }) => {
    await openEditor(page, drawingId);

    // Excalidraw's own floating help button, independent of the menu -- still
    // in the DOM (Excalidraw renders it unconditionally), hidden by CSS.
    await expect(page.locator(".help-icon")).toBeHidden();

    await openMenu(page);
    const menuItems = page.locator('[data-testid="dropdown-menu"] .dropdown-menu-container > *');
    await expect(menuItems.last()).toContainText("Help");
  });
});

test.describe("the top-right control group reads as one bar", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-chrome-topright-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("Excalidraw's own Library trigger drops its own background inside the shared bar", async ({
    page,
  }) => {
    await openEditor(page, drawingId);

    const wrapperBg = await page
      .locator(".layer-ui__wrapper__top-right")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const libraryBg = await page
      .locator(".layer-ui__wrapper__top-right .sidebar-trigger.default-sidebar-trigger")
      .evaluate((el) => getComputedStyle(el).backgroundColor);

    expect(wrapperBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(libraryBg).toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("the laser pointer -- one control, present alone (NIL-374)", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-chrome-laser-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("the standalone toggle is visible alone on a board, and the flyout duplicate is hidden", async ({
    page,
  }) => {
    await openEditor(page, drawingId);

    const standalone = page.getByTestId("toolbar-LaserPointer");
    await expect(standalone).toBeVisible();

    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await expect(page.getByTestId("toolbar-laser")).toHaveCount(1);
    await expect(page.getByTestId("toolbar-laser")).toBeHidden();
    await page.keyboard.press("Escape");
  });

  test("carries the K hint, and arms the laser tool", async ({ page }) => {
    await openEditor(page, drawingId);

    const hint = await page
      .locator(".ToolIcon__LaserPointer")
      .evaluate((el) => getComputedStyle(el, "::after").content);
    expect(hint).toBe('"K"');

    // The checkbox itself sits under its own icon in paint order (Excalidraw's
    // usual custom-checkbox styling); the label is the real click surface.
    await page.locator(".ToolIcon__LaserPointer").click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__.getAppState()
          .activeTool?.name === "laser",
    );
  });
});
