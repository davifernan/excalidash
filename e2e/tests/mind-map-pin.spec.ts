import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene, toolbarButton } from "./helpers/editor";

/**
 * Mind Map v2, pinning (NIL-571, second slice).
 *
 * The pure decision (`pinnedNodeIds`/`togglePinOps`, and `layoutOps`'s
 * pin-awareness) has its own DOM-free tests in
 * `frontend/src/mindMap/mindMapScene.test.ts`. What only holds with the
 * real editor is checked here: the "P" shortcut actually pins/unpins a
 * selected node, a pinned node's hand-set position survives the "Arrange
 * mind map" command that discards everyone else's, and -- v1's central
 * promise, still unbroken -- none of this ever triggers a layout run on
 * its own or on another client.
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

const layoutRunCount = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getMindMapLayoutRunCount(),
  );

/** One map: a root with two sibling children. */
const buildRootWithTwoChildren = async (page: Page) => {
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
  await page.keyboard.type("Child1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__?.getSceneElements()
      .filter((e: any) => e.customData?.excalidash?.mindMap).length === 3,
  );
  await page.keyboard.type("Child2");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  return mindMapNodes(page);
};

const dragTo = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.locator("canvas").last().click({ position: from });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
};

const select = (page: Page, nodeId: string, node: { x: number; width: number; y: number; height: number }) =>
  page.locator("canvas").last().click({
    position: { x: node.x + node.width / 2, y: node.y + node.height / 2 },
  });

test.describe("mind map v2: pinning", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-mind-map-pin-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("P pins a selected node; Arrange mind map leaves its position untouched", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildRootWithTwoChildren(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    // Drag child1 far away from where layout would put it, then pin it there.
    await dragTo(
      page,
      { x: child1.x + child1.width / 2, y: child1.y + child1.height / 2 },
      { x: 900, y: 700 },
    );
    await page.waitForFunction(
      (expected) => {
        const el = (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === expected.id);
        return el && Math.round(el.x) === expected.x;
      },
      { id: child1.id, x: 900 - child1.width / 2 },
    );

    const beforePin = await mindMapNodes(page);
    const child1Moved = beforePin.find((n: any) => n.id === child1.id);

    await select(page, child1.id, child1Moved);
    await page.keyboard.press("p");
    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.pinned === true,
      child1.id,
    );

    // Arrange mind map via the real hamburger menu entry.
    await page.getByTestId("main-menu-trigger").click();
    await page.getByTestId("menu-arrange-mind-map").click();

    const after = await mindMapNodes(page);
    const child1After = after.find((n: any) => n.id === child1.id);
    expect(Math.round(child1After.x)).toBe(Math.round(child1Moved.x));
    expect(Math.round(child1After.y)).toBe(Math.round(child1Moved.y));
  });

  test("unpinning with P again lets the next Arrange mind map reposition the node", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildRootWithTwoChildren(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    await dragTo(
      page,
      { x: child1.x + child1.width / 2, y: child1.y + child1.height / 2 },
      { x: 900, y: 700 },
    );
    const moved = (await mindMapNodes(page)).find((n: any) => n.id === child1.id);

    await select(page, child1.id, moved);
    await page.keyboard.press("p"); // pin
    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.pinned === true,
      child1.id,
    );
    await page.keyboard.press("p"); // unpin
    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.pinned !== true,
      child1.id,
    );

    await page.getByTestId("main-menu-trigger").click();
    await page.getByTestId("menu-arrange-mind-map").click();

    await page.waitForFunction(
      (expected) => {
        const el = (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === expected.id);
        return el && Math.round(el.x) !== expected.movedX;
      },
      { id: child1.id, movedX: Math.round(moved.x) },
    );

    const after = await mindMapNodes(page);
    const child1After = after.find((n: any) => n.id === child1.id);
    expect(Math.round(child1After.x)).not.toBe(Math.round(moved.x));
  });

  test("pinning is a single non-structural patch: no layout run", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildRootWithTwoChildren(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    const baseline = await layoutRunCount(page);

    await select(page, child1.id, child1);
    await page.keyboard.press("p");
    await page.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.pinned === true,
      child1.id,
    );

    const afterPin = await layoutRunCount(page);
    expect(afterPin).toBe(baseline);
  });

  /**
   * v1's central collaboration claim, re-verified for pinning: a pin toggle
   * on client A converges on client B without B ever running a layout pass
   * of its own.
   */
  test("a pin toggle on one client converges on another without a layout run there", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await openEditor(await ctxA.newPage(), drawingId);
    const pageB = await openEditor(await ctxB.newPage(), drawingId);

    const nodes = await buildRootWithTwoChildren(pageA);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    await pageB.waitForFunction(
      () =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((e: any) => e.customData?.excalidash?.mindMap).length === 3,
      { timeout: 15000 },
    );
    const baselineB = await layoutRunCount(pageB);

    await select(pageA, child1.id, child1);
    await pageA.keyboard.press("p");

    await pageB.waitForFunction(
      (id) =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === id)?.customData?.excalidash?.mindMap?.pinned === true,
      child1.id,
      { timeout: 15000 },
    );

    const afterB = await layoutRunCount(pageB);
    expect(afterB).toBe(baselineB);

    await ctxA.close();
    await ctxB.close();
  });
});
