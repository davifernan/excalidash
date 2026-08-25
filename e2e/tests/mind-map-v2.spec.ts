import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene, toolbarButton } from "./helpers/editor";

/**
 * Mind Map v2, drag-to-reparent (NIL-571, first slice).
 *
 * The pure decision (`dropTargetFor`/`reparentOps`) has its own DOM-free
 * tests in `frontend/src/mindMap/mindMapScene.test.ts`. What only holds with
 * the real editor is checked here: dropping a dragged node onto another one
 * actually changes its parent, the drop-target preview is visible *before*
 * release, the whole thing is one undo step, and -- v1's central promise,
 * still unbroken -- a structural reparent on one client never triggers a
 * layout run on another.
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

/** One map: a root with two sibling children -- enough to drag one onto the other, same map, same tree. */
const buildRootWithTwoChildren = async (page: Page) => {
  await armMindMap(page);
  await page.locator("canvas").last().click({ position: { x: 200, y: 150 } });
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__?.getSceneElements()
      .some((e: any) => e.customData?.excalidash?.mindMap?.parentId === null),
  );
  await page.keyboard.type("Root");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab"); // Child1, under Root
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__?.getSceneElements()
      .filter((e: any) => e.customData?.excalidash?.mindMap).length === 2,
  );
  await page.keyboard.type("Child1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter"); // Child2, sibling of Child1 under the same Root
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__?.getSceneElements()
      .filter((e: any) => e.customData?.excalidash?.mindMap).length === 3,
  );
  await page.keyboard.type("Child2");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  return mindMapNodes(page);
};

const dragOnto = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.locator("canvas").last().click({ position: from });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
};

const center = (node: any) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 });

test.describe("mind map v2: drag-to-reparent", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-mind-map-v2-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("dragging a node onto another node reparents it there", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildRootWithTwoChildren(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1, child2] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    // Drag child2 onto child1: child2 becomes child1's child instead of root's.
    await dragOnto(page, center(child2), center(child1));
    await page.mouse.up();

    await page.waitForFunction(
      (expected) => {
        const el = (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === expected.childId);
        return el?.customData?.excalidash?.mindMap?.parentId === expected.newParentId;
      },
      { childId: child2.id, newParentId: child1.id },
    );

    const after = await mindMapNodes(page);
    const child2After = after.find((n: any) => n.id === child2.id);
    expect(child2After.mindMap.parentId).toBe(child1.id);
  });

  test("drop-target preview is visible before release", async ({ page }) => {
    await openEditor(page, drawingId);
    const nodes = await buildRootWithTwoChildren(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1, child2] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    await dragOnto(page, center(child2), center(child1));

    const highlight = page.locator('[data-testid="mind-map-drop-highlight"]');
    await expect(highlight).toBeVisible();
    await expect(highlight).toHaveAttribute("data-target-id", child1.id);

    await page.mouse.up();
    await expect(highlight).toHaveCount(0);
  });

  test("one drag-to-reparent, one Ctrl+Z, and the node is back under its original parent", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    const nodes = await buildRootWithTwoChildren(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1, child2] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    await dragOnto(page, center(child2), center(child1));
    await page.mouse.up();

    await page.waitForFunction(
      (expected) => {
        const el = (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === expected.childId);
        return el?.customData?.excalidash?.mindMap?.parentId === expected.newParentId;
      },
      { childId: child2.id, newParentId: child1.id },
    );

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");

    await page.waitForFunction(
      (expected) => {
        const el = (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === expected.childId);
        return el?.customData?.excalidash?.mindMap?.parentId === expected.originalParentId;
      },
      { childId: child2.id, originalParentId: root.id },
    );

    const restored = await mindMapNodes(page);
    const child2Restored = restored.find((n: any) => n.id === child2.id);
    expect(child2Restored.mindMap.parentId).toBe(root.id);
  });

  /**
   * v1's central collaboration claim, re-verified for the new reparent
   * command: a structural reparent on client A converges on client B
   * without B ever running a layout pass of its own.
   */
  test("a reparent on one client converges on another without a layout run there", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await openEditor(await ctxA.newPage(), drawingId);
    const pageB = await openEditor(await ctxB.newPage(), drawingId);

    const nodes = await buildRootWithTwoChildren(pageA);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const [child1, child2] = nodes.filter((n: any) => n.mindMap.parentId === root.id);

    await pageB.waitForFunction(
      () =>
        (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((e: any) => e.customData?.excalidash?.mindMap).length === 3,
      { timeout: 15000 },
    );
    const baselineB = await layoutRunCount(pageB);

    await dragOnto(pageA, center(child2), center(child1));
    await pageA.mouse.up();

    await pageB.waitForFunction(
      (expected) => {
        const el = (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === expected.childId);
        return el?.customData?.excalidash?.mindMap?.parentId === expected.newParentId;
      },
      { childId: child2.id, newParentId: child1.id },
      { timeout: 15000 },
    );

    const afterB = await layoutRunCount(pageB);
    expect(afterB).toBe(baselineB);

    await ctxA.close();
    await ctxB.close();
  });
});
