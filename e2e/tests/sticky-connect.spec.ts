import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

/**
 * Reaching for the note tool, and pulling arrows out of a note.
 *
 * Both depend on markup and behaviour that Excalidraw does not promise: the
 * button is portalled into its toolbar, and an arrow is started by handing its
 * canvas a pointer event. Neither can be checked anywhere but in a browser, and
 * both fail visibly here the day a version changes underneath them.
 */

const openEditor = async (page: Page, drawingId: string) => {
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector("canvas");
  await page.waitForFunction(() => !!(window as any).__EXCALIDASH_EXCALIDRAW_API__);
  return page;
};

const scene = (page: Page) =>
  page.evaluate(() => {
    const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
    return api.getSceneElements().map((element: any) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      backgroundColor: element.backgroundColor,
      containerId: element.containerId,
      fontSize: element.fontSize,
      text: element.text,
      sticky: element.customData?.excalidash?.sticky ?? null,
    }));
  });

const notes = async (page: Page) => (await scene(page)).filter((e: any) => e.sticky);
const labels = async (page: Page) => (await scene(page)).filter((e: any) => e.containerId);

const stickyButton = (page: Page) => page.getByTestId("toolbar-sticky");

/** Place a note by arming the tool and clicking the canvas, as a person would. */
const armTool = async (page: Page) => {
  await stickyButton(page).click();
  // The tool is set through React state; a click landing before that commits
  // would be read as a selection drag instead.
  await page.waitForFunction(
    () =>
      (window as any).__EXCALIDASH_EXCALIDRAW_API__.getAppState().activeTool
        ?.customType === "sticky",
  );
};

const placeNote = async (page: Page, at: { x: number; y: number }) => {
  await armTool(page);
  await page.locator("canvas").last().click({ position: at });
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_EXCALIDRAW_API__
      .getSceneElements()
      .some((element: any) => element.customData?.excalidash?.sticky),
  );
};

const settle = async (page: Page) => {
  // The upkeep pass runs off the change event and applies on the next frame.
  await page.waitForTimeout(400);
};

test.describe("the note tool in the toolbar", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-sticky-tb-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("sits among the other tools, not off in a corner", async ({ page }) => {
    await openEditor(page, drawingId);
    const inToolbar = page.locator('.App-toolbar [data-testid="toolbar-sticky"]');
    await expect(inToolbar).toBeVisible();
    await expect(inToolbar).toContainText("N");
  });

  test("answers to its key", async ({ page }) => {
    await openEditor(page, drawingId);
    await page.locator("canvas").last().click({ position: { x: 700, y: 500 } });
    await page.keyboard.press("n");
    await page.waitForFunction(
      () =>
        (window as any).__EXCALIDASH_EXCALIDRAW_API__.getAppState().activeTool
          ?.customType === "sticky",
    );

    await page.keyboard.press("n");
    await page.waitForFunction(
      () =>
        (window as any).__EXCALIDASH_EXCALIDRAW_API__.getAppState().activeTool
          ?.type === "selection",
    );
  });

  test("does not fire while somebody is writing an n", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.keyboard.type("nnn");
    await page.keyboard.press("Escape");
    await settle(page);

    const written = await labels(page);
    expect(written[0].text).toBe("nnn");
    expect(await notes(page)).toHaveLength(1);
  });

  test("stays in the toolbar after the toolbar is rebuilt", async ({ page }) => {
    // Zen mode and the mobile breakpoint both unmount and rebuild the toolbar.
    // The button is portalled into it, so it has to find its way back.
    await openEditor(page, drawingId);
    await expect(page.locator('.App-toolbar [data-testid="toolbar-sticky"]')).toBeVisible();

    await page.setViewportSize({ width: 480, height: 800 });
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="toolbar-sticky"]')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(500);
    const back = page.locator('.App-toolbar [data-testid="toolbar-sticky"]');
    await expect(back).toBeVisible();

    // And still works afterwards.
    await placeNote(page, { x: 400, y: 300 });
    expect(await notes(page)).toHaveLength(1);
  });
});

test.describe("dragging an arrow out of a note", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-sticky-arrow-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  const escapeEditor = async (page: Page) => {
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.keyboard.press("Escape");
    await settle(page);
  };

  test("shows points on the note under the pointer", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    await page.mouse.move(400, 300);
    await expect(page.getByTestId("sticky-handle-right")).toBeVisible();
    await expect(page.getByTestId("sticky-handle-left")).toBeVisible();
    await expect(page.getByTestId("sticky-handle-top")).toBeVisible();
    await expect(page.getByTestId("sticky-handle-bottom")).toBeVisible();
  });

  test("hides them again once the pointer leaves and nothing is selected", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    await page.mouse.move(900, 550);
    await page.mouse.click(900, 550);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("sticky-handle-right")).toHaveCount(0);
  });

  test("joins two notes with an arrow bound to both", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 350, y: 300 });
    await escapeEditor(page);
    await placeNote(page, { x: 800, y: 300 });
    await escapeEditor(page);
    await page.mouse.click(1050, 600);
    await settle(page);

    // Hover the left note so its points appear, then pull from the right one.
    await page.mouse.move(350, 300);
    const handle = page.getByTestId("sticky-handle-right");
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // A person takes longer than a frame between pressing and moving; the tool
    // switch needs that frame.
    await page.waitForTimeout(120);
    await page.mouse.move(650, 300, { steps: 12 });
    await page.mouse.move(800, 300, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const drawn = await scene(page);
    const arrows = drawn.filter((element: any) => element.type === "arrow");
    expect(arrows).toHaveLength(1);

    const bindings = await page.evaluate(() => {
      const arrow = (window as any).__EXCALIDASH_EXCALIDRAW_API__
        .getSceneElements()
        .find((element: any) => element.type === "arrow");
      return {
        start: arrow?.startBinding?.elementId ?? null,
        end: arrow?.endBinding?.elementId ?? null,
      };
    });
    const placed = (await notes(page)).sort((a: any, b: any) => a.x - b.x);
    expect(bindings.start).toBe(placed[0].id);
    expect(bindings.end).toBe(placed[1].id);
  });

  test("keeps the arrow attached when a note is moved", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 350, y: 300 });
    await escapeEditor(page);
    await placeNote(page, { x: 800, y: 300 });
    await escapeEditor(page);
    await page.mouse.click(1050, 600);
    await settle(page);

    await page.mouse.move(350, 300);
    const box = (await page.getByTestId("sticky-handle-right").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(650, 300, { steps: 12 });
    await page.mouse.move(800, 300, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const before = await page.evaluate(() => {
      const arrow = (window as any).__EXCALIDASH_EXCALIDRAW_API__
        .getSceneElements()
        .find((element: any) => element.type === "arrow");
      return { x: arrow.x, y: arrow.y };
    });

    // Drag the second note downwards; a bound arrow has to follow it.
    await page.mouse.move(800, 300);
    await page.mouse.down();
    await page.mouse.move(800, 480, { steps: 10 });
    await page.mouse.up();
    await settle(page);

    const after = await page.evaluate(() => {
      const arrow = (window as any).__EXCALIDASH_EXCALIDRAW_API__
        .getSceneElements()
        .find((element: any) => element.type === "arrow");
      return { x: arrow.x, y: arrow.y, points: arrow.points };
    });
    expect(after).not.toEqual(before);
  });
});

test.describe("a note dropped into a frame", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-sticky-frame-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("becomes part of it, and travels with it", async ({ page }) => {
    // Excalidraw does this for every shape it draws inside a frame. A note that
    // skipped it sat on the frame without belonging to it and stayed behind the
    // moment the frame was moved.
    await openEditor(page, drawingId);
    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    const box = (await canvas.boundingBox())!;

    await canvas.click({ position: { x: 950, y: 560 } });
    await page.keyboard.press("f");
    await page.mouse.move(box.x + 380, box.y + 100);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(box.x + 800, box.y + 420, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    await placeNote(page, { x: 600, y: 260 });
    await page.keyboard.press("Escape");
    await settle(page);

    const joined = await page.evaluate(() => {
      const els = (window as any).__EXCALIDASH_EXCALIDRAW_API__.getSceneElements();
      const frame = els.find((e: any) => e.type === "frame");
      const note = els.find((e: any) => e.customData?.excalidash?.sticky);
      return { belongs: note?.frameId === frame?.id, y: note?.y };
    });
    expect(joined.belongs).toBe(true);

    // Move the frame with the keyboard rather than a drag: selecting it by its
    // name bar and pulling depends on pixel geometry that shifts with the
    // window, and this asks the same question without any of that.
    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const frame = api.getSceneElements().find((e: any) => e.type === "frame");
      api.updateScene({ appState: { selectedElementIds: { [frame.id]: true } } });
    });
    await page.waitForTimeout(300);
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    await settle(page);

    const movedTo = await page.evaluate(
      () =>
        (window as any).__EXCALIDASH_EXCALIDRAW_API__
          .getSceneElements()
          .find((e: any) => e.customData?.excalidash?.sticky)?.y,
    );
    expect(movedTo).toBeGreaterThan(joined.y);
  });
});
