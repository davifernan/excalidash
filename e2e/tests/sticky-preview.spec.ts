import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

/**
 * The note that is not there yet.
 *
 * A note is placed by its centre, and until one appears there is nothing to say
 * whether the click point is the middle or a corner. The ghost answers that
 * before the click, so these check the two things that make it useful: it sits
 * exactly where the note will, and it is the size the note will be — at any
 * zoom, which is where a preview drawn in screen pixels would quietly lie.
 */

const openEditor = async (page: Page, drawingId: string) => {
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector("canvas");
  await page.waitForFunction(() => !!(window as any).__EXCALIDASH_EXCALIDRAW_API__);
  await page.waitForTimeout(600);
};

const armTool = async (page: Page) => {
  await page.getByTestId("toolbar-sticky").click();
  await page.waitForFunction(
    () =>
      (window as any).__EXCALIDASH_EXCALIDRAW_API__.getAppState().activeTool
        ?.customType === "sticky",
  );
};

const ghost = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="sticky-preview"]') as HTMLElement | null;
    if (!el) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      opacity: Number(style.opacity),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centreX: Math.round(rect.x + rect.width / 2),
      centreY: Math.round(rect.y + rect.height / 2),
      background: style.backgroundColor,
      pointerEvents: style.pointerEvents,
    };
  });

test.describe("the ghost note under the pointer", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-ghost-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("is not there until the tool is", async ({ page }) => {
    await openEditor(page, drawingId);
    expect(await ghost(page)).toBeNull();
  });

  test("sits on the pointer, at the size the note will be", async ({ page }) => {
    await openEditor(page, drawingId);
    const box = (await page.locator("canvas").last().boundingBox())!;
    await armTool(page);
    await page.mouse.move(box.x + 560, box.y + 270, { steps: 6 });
    await page.waitForTimeout(200);

    const seen = (await ghost(page))!;
    expect(seen.centreX).toBe(Math.round(box.x + 560));
    expect(seen.centreY).toBe(Math.round(box.y + 270));
    expect(seen.width).toBe(200);
    expect(seen.height).toBe(200);
  });

  test("is see-through, and does not swallow the click", async ({ page }) => {
    await openEditor(page, drawingId);
    const box = (await page.locator("canvas").last().boundingBox())!;
    await armTool(page);
    await page.mouse.move(box.x + 560, box.y + 270, { steps: 6 });
    await page.waitForTimeout(200);

    const seen = (await ghost(page))!;
    expect(seen.opacity).toBeGreaterThan(0);
    expect(seen.opacity).toBeLessThan(0.7);
    // It lies directly under the cursor; if it took pointer events, no note
    // could ever be placed.
    expect(seen.pointerEvents).toBe("none");

    await page.locator("canvas").last().click({ position: { x: 560, y: 270 } });
    await page.waitForFunction(() =>
      (window as any).__EXCALIDASH_EXCALIDRAW_API__
        .getSceneElements()
        .some((e: any) => e.customData?.excalidash?.sticky),
    );
  });

  test("shrinks and grows with the board", async ({ page }) => {
    // Drawn in screen pixels it would keep its size while the note it promises
    // halves, which is worse than showing nothing.
    await openEditor(page, drawingId);
    const box = (await page.locator("canvas").last().boundingBox())!;
    await armTool(page);
    await page.mouse.move(box.x + 560, box.y + 270, { steps: 6 });
    await page.waitForTimeout(200);
    const atFullSize = (await ghost(page))!;

    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      api.updateScene({ appState: { ...api.getAppState(), zoom: { value: 0.5 } } });
    });
    await page.mouse.move(box.x + 561, box.y + 271);
    await page.waitForTimeout(200);
    const zoomedOut = (await ghost(page))!;

    expect(zoomedOut.width).toBeCloseTo(atFullSize.width / 2, -1);
  });

  test("takes the colour that was chosen", async ({ page }) => {
    await openEditor(page, drawingId);
    const box = (await page.locator("canvas").last().boundingBox())!;
    await armTool(page);
    await page.getByRole("button", { name: "Blue", exact: true }).click();
    await page.mouse.move(box.x + 560, box.y + 270, { steps: 6 });
    await page.waitForTimeout(200);

    // #bfdbfe
    expect((await ghost(page))!.background).toBe("rgb(191, 219, 254)");
  });

  test("goes away when another tool is picked up", async ({ page }) => {
    // Reaching for the rectangle takes the note tool out of your hand without
    // ever telling this code. The button used to stay lit and the ghost kept
    // following the pointer over a tool that was long gone.
    await openEditor(page, drawingId);
    const box = (await page.locator("canvas").last().boundingBox())!;
    await armTool(page);
    await page.mouse.move(box.x + 560, box.y + 270, { steps: 6 });
    await page.waitForTimeout(200);
    expect(await ghost(page)).not.toBeNull();

    await page.locator('label:has([data-testid="toolbar-rectangle"])').click();
    await page.waitForTimeout(400);
    expect(await ghost(page)).toBeNull();
    await expect(page.getByTestId("toolbar-sticky")).not.toBeChecked();
  });

  test("goes away when the tool is put down", async ({ page }) => {
    await openEditor(page, drawingId);
    const box = (await page.locator("canvas").last().boundingBox())!;
    await armTool(page);
    await page.mouse.move(box.x + 560, box.y + 270, { steps: 6 });
    await page.waitForTimeout(200);
    expect(await ghost(page)).not.toBeNull();

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    expect(await ghost(page)).toBeNull();
  });
});
