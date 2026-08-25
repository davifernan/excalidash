import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene, toolbarButton } from "./helpers/editor";

/**
 * Mind Map v2, collapse (NIL-571, third slice).
 *
 * The pure decision (`collapsedNodeIds`/`collapsedHiddenIds`/
 * `toggleCollapseOps`) has its own DOM-free tests in
 * `frontend/src/mindMap/mindMapScene.test.ts`. What only holds with the
 * real editor is checked here: the floating toolbar's "Collapse" button
 * actually hides the branch behind a mask and a count badge, the badge
 * itself expands it again, collapsing is one undo step, a collapsed
 * subtree's own elements are byte-for-byte unchanged (the JSON-roundtrip
 * requirement -- a client without this feature loses nothing), and --
 * v1's central promise, still unbroken -- none of this ever triggers a
 * layout run on its own or on another client.
 */

const mindMapButton = (page: Page) => toolbarButton(page, "mind-map");

const armMindMap = async (page: Page) => {
  await mindMapButton(page).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getAppState()
        .activeTool?.customType === "mindMap",
  );
};

const mindMapNodes = async (page: Page) => (await scene(page)).filter((element: any) => element.mindMap);

const allSceneElements = (page: Page) =>
  page.evaluate(() => (window as any).__EXCALIDASH_TEST__?.getSceneElements());

const layoutRunCount = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getMindMapLayoutRunCount(),
  );

/** Root -> Child (which itself has a Grandchild) -> Grandchild. One branch worth collapsing. */
const buildBranch = async (page: Page) => {
  await armMindMap(page);
  await page.locator("canvas").last().click({ position: { x: 200, y: 150 } });
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__?.getSceneElements()
      .some((e: any) => e.customData?.excalidash?.mindMap?.parentId === null),
  );
  await page.keyboard.type("Root");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__?.getSceneElements()
      .filter((e: any) => e.customData?.excalidash?.mindMap).length === 2,
  );
  await page.keyboard.type("Child");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__?.getSceneElements()
      .filter((e: any) => e.customData?.excalidash?.mindMap).length === 3,
  );
  await page.keyboard.type("Grandchild");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  return mindMapNodes(page);
};

const select = (page: Page, node: { x: number; width: number; y: number; height: number }) =>
  page.locator("canvas").last().click({
    position: { x: node.x + node.width / 2, y: node.y + node.height / 2 },
  });

const collapseViaToolbar = async (page: Page) => {
  await page.getByTestId("mind-map-collapse-button").click();
};

test.describe("mind map v2: collapse", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-mind-map-collapse-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("the floating toolbar's Collapse button hides the branch behind a mask and a count badge", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    const nodes = await buildBranch(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const child = nodes.find((n: any) => n.mindMap.parentId === root.id);
    const grandchild = nodes.find((n: any) => n.mindMap.parentId === child.id);

    await select(page, child);
    await expect(page.getByTestId("mind-map-collapse-button")).toBeVisible();
    await collapseViaToolbar(page);

    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.collapsed === true,
      child.id,
    );

    const badge = page.locator('[data-testid="mind-map-collapse-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("1");

    const masks = page.locator('[data-testid="mind-map-collapse-mask"]');
    expect(await masks.count()).toBeGreaterThan(0);

    // The collapsed node's own toolbar is gone (its badge is the only control it needs).
    await expect(page.getByTestId("mind-map-collapse-button")).toHaveCount(0);

    // The grandchild's OWN data is completely unchanged -- a client without
    // this feature (or a plain JSON export) sees it exactly as before.
    const raw = await allSceneElements(page);
    const grandchildRaw = raw.find((e: any) => e.id === grandchild.id);
    expect(grandchildRaw.opacity).toBe(100);
    expect(grandchildRaw.isDeleted).toBe(false);
    expect(grandchildRaw.x).toBe(grandchild.x);
    expect(grandchildRaw.y).toBe(grandchild.y);
  });

  test("clicking the badge expands the branch again", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildBranch(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const child = nodes.find((n: any) => n.mindMap.parentId === root.id);

    await select(page, child);
    await collapseViaToolbar(page);
    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.collapsed === true,
      child.id,
    );

    await page.locator('[data-testid="mind-map-collapse-badge"]').click();

    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.collapsed !== true,
      child.id,
    );
    await expect(page.locator('[data-testid="mind-map-collapse-badge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="mind-map-collapse-mask"]')).toHaveCount(0);
  });

  test("one Collapse, one Ctrl+Z, and the branch is expanded again", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildBranch(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const child = nodes.find((n: any) => n.mindMap.parentId === root.id);

    await select(page, child);
    await collapseViaToolbar(page);
    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.collapsed === true,
      child.id,
    );

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");

    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.collapsed !== true,
      child.id,
    );
    await expect(page.locator('[data-testid="mind-map-collapse-badge"]')).toHaveCount(0);
  });

  test("collapsing is a single non-structural patch: no layout run", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildBranch(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const child = nodes.find((n: any) => n.mindMap.parentId === root.id);

    const baseline = await layoutRunCount(page);

    await select(page, child);
    await collapseViaToolbar(page);
    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.collapsed === true,
      child.id,
    );

    expect(await layoutRunCount(page)).toBe(baseline);
  });

  /**
   * v1's central collaboration claim, re-verified for collapse: a collapse
   * toggle on client A converges on client B without B ever running a
   * layout pass of its own.
   */
  test("a collapse on one client converges on another without a layout run there", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await openEditor(await ctxA.newPage(), drawingId);
    const pageB = await openEditor(await ctxB.newPage(), drawingId);

    const nodes = await buildBranch(pageA);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const child = nodes.find((n: any) => n.mindMap.parentId === root.id);

    await pageB.waitForFunction(
      () =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((e: any) => e.customData?.excalidash?.mindMap).length === 3,
      { timeout: 15000 },
    );
    const baselineB = await layoutRunCount(pageB);

    await select(pageA, child);
    await collapseViaToolbar(pageA);

    await pageB.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.collapsed === true,
      child.id,
      { timeout: 15000 },
    );

    expect(await layoutRunCount(pageB)).toBe(baselineB);

    await ctxA.close();
    await ctxB.close();
  });
});
