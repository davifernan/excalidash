import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene, toolbarButton } from "./helpers/editor";

/**
 * Mind Map v1, in a real browser (NIL-570).
 *
 * The pure layout core and tree normalization have their own DOM-free tests
 * (`frontend/src/mindMap/model.test.ts`, `layout` cases in the same file,
 * `mindMapScene.test.ts`, `useMindMapIntegrity.test.ts`). What only holds
 * with the real editor is checked here: the tool actually reaches the
 * toolbar, Tab/Enter actually open the label editor, a real pointer drag
 * actually moves a whole subtree rigidly, and -- the package's central
 * collaboration claim -- a structural action on one client never triggers a
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

test.describe("mind map", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-mind-map-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("click creates a root and starts text entry immediately", async ({ page }) => {
    await openEditor(page, drawingId);
    await armMindMap(page);
    await page.locator("canvas").last().click({ position: { x: 300, y: 300 } });

    await page.waitForFunction(() =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .some((element: any) => element.customData?.excalidash?.mindMap?.parentId === null),
    );
    await page.keyboard.type("Root idea");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const nodes = await mindMapNodes(page);
    expect(nodes).toHaveLength(1);
    const label = (await scene(page)).find((element: any) => element.containerId === nodes[0].id);
    expect(label?.text).toBe("Root idea");
  });

  test("Tab adds a child, Enter adds a sibling, both start text entry", async ({ page }) => {
    await openEditor(page, drawingId);
    await armMindMap(page);
    await page.locator("canvas").last().click({ position: { x: 300, y: 300 } });
    await page.waitForFunction(() =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .some((element: any) => element.customData?.excalidash?.mindMap?.parentId === null),
    );
    await page.keyboard.type("Root");
    await page.keyboard.press("Escape");

    await page.keyboard.press("Tab");
    await page.waitForFunction(() => {
      const nodes = (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .filter((element: any) => element.customData?.excalidash?.mindMap);
      return nodes?.length === 2;
    });
    await page.keyboard.type("Child");
    await page.keyboard.press("Escape");

    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const nodes = (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .filter((element: any) => element.customData?.excalidash?.mindMap);
      return nodes?.length === 3;
    });
    await page.keyboard.type("Sibling");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const nodes = await mindMapNodes(page);
    expect(nodes).toHaveLength(3);
    const root = nodes.find((node: any) => node.mindMap.parentId === null);
    const others = nodes.filter((node: any) => node.mindMap.parentId === root!.id);
    // Tab made a child of the root; Enter on that child made a sibling under
    // the SAME parent (the root) -- not a child of the child.
    expect(others).toHaveLength(2);
  });

  test("dragging a node moves its whole subtree by the same delta", async ({ page }) => {
    await openEditor(page, drawingId);
    await armMindMap(page);
    await page.locator("canvas").last().click({ position: { x: 200, y: 300 } });
    await page.waitForFunction(() =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .some((element: any) => element.customData?.excalidash?.mindMap?.parentId === null),
    );
    await page.keyboard.type("Root");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab"); // child of root
    await page.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 2,
    );
    await page.keyboard.type("Node");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab"); // grandchild, child of the child (still selected)
    await page.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 3,
    );
    await page.keyboard.press("Escape");

    const before = await mindMapNodes(page);
    const root = before.find((n: any) => n.mindMap.parentId === null);
    const child = before.find((n: any) => n.mindMap.parentId === root.id);
    const grandchild = before.find((n: any) => n.mindMap.parentId === child.id);

    // Select and drag the child (which carries the grandchild along).
    await page.locator("canvas").last().click({
      position: { x: child.x + child.width / 2, y: child.y + child.height / 2 },
    });
    const from = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
    const delta = { x: 60, y: -40 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + delta.x, from.y + delta.y, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
      (expected) => {
        const nodes = (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap);
        const moved = nodes?.find((n: any) => n.id === expected.childId);
        return moved && Math.round(moved.x) === expected.x;
      },
      { childId: child.id, x: Math.round(child.x + delta.x) },
    );

    const after = await mindMapNodes(page);
    const rootAfter = after.find((n: any) => n.id === root.id);
    const childAfter = after.find((n: any) => n.id === child.id);
    const grandchildAfter = after.find((n: any) => n.id === grandchild.id);

    // Root: untouched. Child and grandchild: same delta, measured.
    expect(rootAfter.x).toBeCloseTo(root.x, 0);
    expect(rootAfter.y).toBeCloseTo(root.y, 0);
    expect(childAfter.x - child.x).toBeCloseTo(delta.x, 0);
    expect(childAfter.y - child.y).toBeCloseTo(delta.y, 0);
    expect(grandchildAfter.x - grandchild.x).toBeCloseTo(delta.x, 0);
    expect(grandchildAfter.y - grandchild.y).toBeCloseTo(delta.y, 0);
  });

  test("deleting a node removes its whole subtree, leaving no dangling parent reference", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    await armMindMap(page);
    await page.locator("canvas").last().click({ position: { x: 200, y: 300 } });
    await page.waitForFunction(() =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .some((element: any) => element.customData?.excalidash?.mindMap?.parentId === null),
    );
    await page.keyboard.type("Root");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 2,
    );
    await page.keyboard.type("Node");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 3,
    );
    await page.keyboard.press("Escape");

    const before = await mindMapNodes(page);
    const root = before.find((n: any) => n.mindMap.parentId === null);
    const child = before.find((n: any) => n.mindMap.parentId === root.id);

    await page.locator("canvas").last().click({
      position: { x: child.x + child.width / 2, y: child.y + child.height / 2 },
    });
    await page.keyboard.press("Delete");

    await page.waitForFunction(
      (rootId) =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 1 &&
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .some((element: any) => element.id === rootId),
      root.id,
    );

    const after = await mindMapNodes(page);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(root.id);
  });

  /**
   * The central collaboration claim (NIL-569/NIL-570): a structural action
   * on client A converges on client B without B ever running a layout pass
   * of its own. Two real browser contexts, per the package's own evidence
   * rule -- shown, not asserted from one page's behaviour.
   */
  test("a structural action on one client converges on another without a layout run there", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await openEditor(await ctxA.newPage(), drawingId);
    const pageB = await openEditor(await ctxB.newPage(), drawingId);

    await armMindMap(pageA);
    await pageA.locator("canvas").last().click({ position: { x: 250, y: 300 } });
    await pageA.waitForFunction(() =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .some((element: any) => element.customData?.excalidash?.mindMap?.parentId === null),
    );
    await pageA.keyboard.type("Root");
    await pageA.keyboard.press("Escape");

    await pageB.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 1,
      { timeout: 15000 },
    );

    const baselineB = await layoutRunCount(pageB);

    // The structural action: add a child on A.
    await pageA.keyboard.press("Tab");
    await pageA.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 2,
    );
    await pageA.keyboard.press("Escape");

    // Convergence: B sees the child too.
    await pageB.waitForFunction(
      () =>
        (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap).length === 2,
      { timeout: 15000 },
    );

    const nodesA = await mindMapNodes(pageA);
    const nodesB = await mindMapNodes(pageB);
    const byId = (nodes: any[]) => Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    expect(byId(nodesB)).toEqual(byId(nodesA));

    // The proof: B's own layout-run counter never moved, even though it
    // just received and rendered a structural change.
    const afterB = await layoutRunCount(pageB);
    expect(afterB).toBe(baselineB);

    await ctxA.close();
    await ctxB.close();
  });
});
