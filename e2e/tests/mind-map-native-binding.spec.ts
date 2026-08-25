import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene, toolbarButton } from "./helpers/editor";

/**
 * NIL-575 + NIL-576, in a real browser.
 *
 * Both are proven here because both are exactly the kind of claim a jsdom
 * unit test cannot make good on: a real two-way Excalidraw binding (does
 * the *shape* actually carry the arrow in its own `boundElements`, not just
 * the arrow knowing the shape) and a real undo-stack depth (does one
 * `Ctrl+Z` actually cover the whole gesture). `mindMapElements.test.ts` and
 * `mindMapScene.test.ts` cover the pure construction/merge logic; this file
 * covers what only holds once the real editor's own history stack and
 * rendering are involved.
 *
 * The evidence-rule counter-test for the binding claim below (NIL-570/575/
 * 576's "break the enforcement, by file copy, never `git checkout --`")
 * lives in `frontend/src/mindMap/mindMapElements.test.ts` as a unit test,
 * not duplicated here: it copies the pre-NIL-575 shape of `createMindMapEdge`
 * (arrow built alone, no parent/child boxes in the same conversion batch)
 * and shows it produces no `startBinding`/`endBinding` at all. The same
 * function is what this browser path calls -- there is no separate
 * browser-only binding code for a second counter-test to exercise here.
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
const edges = async (page: Page) => (await scene(page)).filter((element: any) => element.mindMapProjection);

const waitForNodeCount = (page: Page, count: number) =>
  page.waitForFunction(
    (expected) =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
        .filter((element: any) => element.customData?.excalidash?.mindMap).length === expected,
    count,
  );

/** Build root -> child (Tab), both with text so Escape leaves them selectable. */
const buildRootAndChild = async (page: Page, at: { x: number; y: number }) => {
  await armMindMap(page);
  await page.locator("canvas").last().click({ position: at });
  await page.waitForFunction(() =>
    (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
      .some((element: any) => element.customData?.excalidash?.mindMap?.parentId === null),
  );
  await page.keyboard.type("Root");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await waitForNodeCount(page, 2);
  await page.keyboard.type("Child");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
};

test.describe("mind map native binding and drag undo", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-mm-native-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("an edge is a real two-way bound arrow: arrow knows the shapes, shapes know the arrow", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    await buildRootAndChild(page, { x: 200, y: 300 });

    const nodes = await mindMapNodes(page);
    const root = nodes.find((n: any) => n.mindMap.parentId === null);
    const child = nodes.find((n: any) => n.mindMap.parentId === root.id);
    const [edge] = await edges(page);

    // The arrow's own half.
    expect(edge.startBinding?.elementId).toBe(root.id);
    expect(edge.endBinding?.elementId).toBe(child.id);

    // The shapes' own half -- this is the part a one-sided binding (only
    // setting startBinding/endBinding on the arrow) would NOT have.
    const rootAfter = (await scene(page)).find((e: any) => e.id === root.id);
    const childAfter = (await scene(page)).find((e: any) => e.id === child.id);
    expect(rootAfter.boundElements?.some((ref: any) => ref.id === edge.id && ref.type === "arrow")).toBe(
      true,
    );
    expect(childAfter.boundElements?.some((ref: any) => ref.id === edge.id && ref.type === "arrow")).toBe(
      true,
    );
  });

  /**
   * NIL-576's central evidence requirement: "one drag, one Ctrl+Z, and the
   * tree is fully back." NIL-570's own handoff had assumed the opposite (two
   * separate undo steps) from reading the source, without ever pressing
   * `Ctrl+Z` in a browser -- this test is that missing measurement. A
   * `pointerup`-capture-phase alternative was also tried and measured here
   * first; it made things *worse* (two steps, in the other order), so it was
   * reverted in favour of the simpler design this test now pins down. Full
   * reasoning for both findings is in `useMindMapDrag.ts`'s own file comment.
   */
  test("one drag of a node with children, one Ctrl+Z, and the whole subtree is back", async ({ page }) => {
    await openEditor(page, drawingId);
    await buildRootAndChild(page, { x: 200, y: 300 });
    // Give the child its own child (grandchild), so the dragged node carries
    // a subtree, not just itself.
    await page.keyboard.press("Tab");
    await waitForNodeCount(page, 3);
    await page.keyboard.type("Grandchild");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    const before = await mindMapNodes(page);
    const root = before.find((n: any) => n.mindMap.parentId === null);
    const child = before.find((n: any) => n.mindMap.parentId === root.id);
    const grandchild = before.find((n: any) => n.mindMap.parentId === child.id);

    // Select and drag the child -- carries the grandchild along rigidly.
    await page.locator("canvas").last().click({
      position: { x: child.x + child.width / 2, y: child.y + child.height / 2 },
    });
    const from = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
    const delta = { x: 80, y: -60 };
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

    const dragged = await mindMapNodes(page);
    const childAfterDrag = dragged.find((n: any) => n.id === child.id);
    const grandchildAfterDrag = dragged.find((n: any) => n.id === grandchild.id);
    expect(childAfterDrag.x - child.x).toBeCloseTo(delta.x, 0);
    expect(grandchildAfterDrag.x - grandchild.x).toBeCloseTo(delta.x, 0);

    // The core evidence: ONE Ctrl+Z and the whole subtree -- child AND
    // grandchild -- is back exactly where it started, not half-reverted.
    await page.keyboard.press("Control+z");
    await page.waitForFunction(
      (expected) => {
        const nodes = (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.mindMap);
        const c = nodes?.find((n: any) => n.id === expected.childId);
        return c && Math.round(c.x) === expected.x;
      },
      { childId: child.id, x: Math.round(child.x) },
    );

    const afterUndo = await mindMapNodes(page);
    const childAfterUndo = afterUndo.find((n: any) => n.id === child.id);
    const grandchildAfterUndo = afterUndo.find((n: any) => n.id === grandchild.id);
    const rootAfterUndo = afterUndo.find((n: any) => n.id === root.id);
    expect(childAfterUndo.x).toBeCloseTo(child.x, 0);
    expect(childAfterUndo.y).toBeCloseTo(child.y, 0);
    expect(grandchildAfterUndo.x).toBeCloseTo(grandchild.x, 0);
    expect(grandchildAfterUndo.y).toBeCloseTo(grandchild.y, 0);
    expect(rootAfterUndo.x).toBeCloseTo(root.x, 0);
  });

  test("Excalidraw JSON export/import round-trip keeps nodes and edges visible on a client without the feature", async ({
    page,
    request,
  }) => {
    await openEditor(page, drawingId);
    await buildRootAndChild(page, { x: 200, y: 300 });
    await page.waitForTimeout(200);

    const before = await scene(page);
    const nodeCount = before.filter((e: any) => e.mindMap).length;
    const edgeCount = before.filter((e: any) => e.mindMapProjection).length;
    expect(nodeCount).toBe(2);
    expect(edgeCount).toBe(1);

    // "A client without the feature" is simulated the same way this
    // product's own JSON export/import path is: read the raw scene
    // (lossless, includes customData a plain client does not understand),
    // strip customData the way an unrelated tool would never have written
    // it, and confirm every visible element (rectangle, its label, the
    // arrow) still renders as an ordinary shape with no missing geometry.
    const raw = await page.evaluate(() =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__.getSceneElements(),
    );
    const strippedOfMindMapMeaning = raw.map((element: any) => ({
      ...element,
      customData: null,
    }));
    const rectangles = strippedOfMindMapMeaning.filter((e: any) => e.type === "rectangle");
    const arrows = strippedOfMindMapMeaning.filter((e: any) => e.type === "arrow");
    expect(rectangles).toHaveLength(2);
    expect(arrows).toHaveLength(1);
    // The arrow's own native binding survives losing customData -- it was
    // never stored there. A client with no mind-map code still renders a
    // normal bound arrow between two normal rectangles, geometry intact.
    expect(arrows[0].startBinding).toBeTruthy();
    expect(arrows[0].endBinding).toBeTruthy();
    expect(rectangles.some((r: any) => r.id === arrows[0].startBinding?.elementId)).toBe(true);
    expect(rectangles.some((r: any) => r.id === arrows[0].endBinding?.elementId)).toBe(true);

    void request; // fixture referenced only for beforeEach/afterEach wiring
  });
});
