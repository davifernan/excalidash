import { test, expect, type Page } from "@playwright/test";
import {
  createDrawing,
  deleteDrawing,
  getDrawing,
} from "./helpers/api";

/**
 * E2E Tests for Real-time Collaboration
 * 
 * Tests the real-time collaboration feature mentioned in README:
 * - Multiple users can edit drawings simultaneously
 * - Cursor presence is shared between users
 * - Changes sync between users in real-time
 */

test.describe("Real-time Collaboration", () => {
  let createdDrawingIds: string[] = [];

  const interactiveCanvas = (page: Page) =>
    page.locator("canvas.excalidraw__canvas.interactive");

  // Two things this has to get right, both learned the hard way.
  //
  // A freshly loaded page has no focus on the canvas, so "r" never reaches
  // Excalidraw and the tool stays on selection — the drag that follows draws a
  // selection box and nothing is created.
  //
  // And the left properties panel appears as soon as a drawing tool is picked,
  // covering roughly x < 220. Starting the drag under it presses the panel
  // rather than the canvas, so the default of 120 silently drew nothing.
  const drawRectangle = async (page: Page, x = 420, y = 120) => {
    const canvas = interactiveCanvas(page);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Interactive canvas not found");
    await canvas.click({ position: { x: 700, y: 400 } });
    await page.keyboard.press("r");
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + x + 180, box.y + y + 100, { steps: 5 });
    await page.mouse.up();
  };

  const activeElements = (drawing: Awaited<ReturnType<typeof getDrawing>>) =>
    (drawing.elements || []).filter((element) => !element.isDeleted);

  /** What this browser itself has in its scene, not what the server stores. */
  const sceneElementCount = (page: Page) =>
    page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      if (!api) return -1;
      return api.getSceneElements().filter((e: any) => !e.isDeleted).length;
    });

  const sceneElementIds = (page: Page) =>
    page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      if (!api) return [];
      return api.getSceneElements().filter((e: any) => !e.isDeleted).map((e: any) => e.id);
    });

  test.afterEach(async ({ request }) => {
    for (const id of createdDrawingIds) {
      try {
        await deleteDrawing(request, id);
      } catch {
      }
    }
    createdDrawingIds = [];
  });

  test("should show presence when multiple users view same drawing", async ({ browser, request }) => {
    const drawing = await createDrawing(request, { name: `Collab_Presence_${Date.now()}` });
    createdDrawingIds.push(drawing.id);

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      await page1.goto(`/editor/${drawing.id}`);
      await page2.goto(`/editor/${drawing.id}`);

      await page1.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });
      await page2.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });

      const collaborator1 = page1.locator(".UserList__collaborator .Avatar");
      const collaborator2 = page2.locator(".UserList__collaborator .Avatar");
      await expect(collaborator1).toHaveCount(1);
      await expect(collaborator2).toHaveCount(1);
      await expect(collaborator1).toBeVisible();
      await expect(collaborator2).toBeVisible();
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test("should sync drawing changes between two users", async ({ browser, request }) => {
    const drawing = await createDrawing(request, {
      name: `Collab_Sync_${Date.now()}`,
      elements: [],
    });
    createdDrawingIds.push(drawing.id);

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      await page1.goto(`/editor/${drawing.id}`);
      await page2.goto(`/editor/${drawing.id}`);

      await page1.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });
      await page2.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });

      await expect(page1.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
      await expect(page2.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
      await drawRectangle(page1);
      await expect.poll(async () =>
        activeElements(await getDrawing(request, drawing.id)).length,
      ).toBe(1);

      // Browser 2 loaded the empty scene before the rectangle existed, so it
      // can only know about it through the live update. Assert that directly,
      // in browser 2's own scene.
      //
      // Asserting instead that the board ends up empty after browser 2 selects
      // all and deletes would pass for the wrong reason: if nothing ever
      // arrived, there is nothing to select, the delete does nothing, and an
      // empty board is exactly what a broken live update produces.
      await expect.poll(
        () => sceneElementCount(page2),
        { timeout: 15_000, intervals: [250, 500, 1_000] },
      ).toBe(1);

      // And it is really the same element, not something browser 2 drew.
      const [remoteId, localId] = await Promise.all([
        sceneElementIds(page2),
        sceneElementIds(page1),
      ]);
      expect(remoteId).toEqual(localId);

      // Deleting it in browser 2 must show up in browser 1's own scene. The
      // server going empty is not enough on its own: browser 2's own save
      // produces exactly that, so a break in the 2 -> 1 direction would still
      // look fine. Browser 1 can only know through the live update.
      await interactiveCanvas(page2).click({ position: { x: 400, y: 300 } });
      await page2.keyboard.press("Control+A");
      await page2.keyboard.press("Delete");

      await expect.poll(
        () => sceneElementCount(page1),
        { timeout: 15_000, intervals: [250, 500, 1_000] },
      ).toBe(0);

      await expect.poll(async () =>
        activeElements(await getDrawing(request, drawing.id)).length,
      { timeout: 15_000, intervals: [250, 500, 1_000] }).toBe(0);
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test("should persist drawing changes across page reload", async ({ page, request }) => {
    const drawing = await createDrawing(request, {
      name: `Collab_Persist_${Date.now()}`,
      elements: [],
    });
    createdDrawingIds.push(drawing.id);

    await page.goto(`/editor/${drawing.id}`);
    await page.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });
    await drawRectangle(page, 420, 150);
    let persistedElementId = "";
    await expect.poll(async () => {
      const elements = activeElements(await getDrawing(request, drawing.id));
      persistedElementId = elements[0]?.id || "";
      return elements.length;
    }).toBe(1);
    expect(persistedElementId).not.toBe("");

    await page.reload();
    await page.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });
    await expect.poll(async () =>
      activeElements(await getDrawing(request, drawing.id))
        .some((element) => element.id === persistedElementId),
    ).toBe(true);

    // Deleting after reload proves the persisted element was hydrated into
    // the new editor, not merely left in the database by the old page.
    await expect.poll(async () => {
      await interactiveCanvas(page).click({ position: { x: 400, y: 300 } });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      return activeElements(await getDrawing(request, drawing.id)).length;
    }, { timeout: 15_000, intervals: [250, 500, 1_000] }).toBe(0);
  });

  test("should display collaborator cursor positions", async ({ browser, request }) => {
    const drawing = await createDrawing(request, { name: `Collab_Cursor_${Date.now()}` });
    createdDrawingIds.push(drawing.id);

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      await page1.goto(`/editor/${drawing.id}`);
      await page2.goto(`/editor/${drawing.id}`);

      await page1.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });
      await page2.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });

      await expect(page1.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
      await expect(page2.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
      const canvas1 = interactiveCanvas(page1);
      const box = await canvas1.boundingBox();
      if (!box) throw new Error("Canvas not found");

      await page1.mouse.move(box.x + 250, box.y + 220);
      await page2.waitForTimeout(300);
      const firstCursorFrame = await interactiveCanvas(page2).screenshot();
      await page1.mouse.move(box.x + 520, box.y + 410, { steps: 3 });
      await page2.waitForTimeout(300);
      const secondCursorFrame = await interactiveCanvas(page2).screenshot();

      expect(firstCursorFrame.equals(secondCursorFrame)).toBe(false);
    } finally {
      await context1.close();
      await context2.close();
    }
  });
});
