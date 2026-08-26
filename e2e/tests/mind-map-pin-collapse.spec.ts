import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene } from "./helpers/editor";

/**
 * NIL-593, Schnitt 3: pin and collapse return ambient, over any subtree --
 * no tool, no mode. The decided storage contract (Multica NIL-593 thread,
 * measured against `@excalidraw/excalidraw@0.18.1`'s own source):
 * `customData.excalidash.nodeState`, shared by both facts.
 *
 * This file covers exactly the kickoff's own Nachweispflicht, distinct
 * from `ambient-tree-drag.spec.ts` (drag-follow, unchanged by this
 * schnitt) and `mind-map-teardown.spec.ts` (import, unchanged):
 *
 * 1. Two real browser contexts: collapse on A is visible on B, without a
 *    layout run on B.
 * 2. An Arrange run respects a pinned position and arranges the rest.
 * 3. The three break cases from the investigation, each MEASURED, not
 *    derived -- see each test's own comment for what was actually run and
 *    what came back.
 * 4. One undo step per action (pin, collapse).
 */

const waitForCanvasReady = async (page: Page) => {
  await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
};

const layoutRunCount = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __EXCALIDASH_TEST__: any }
    ).__EXCALIDASH_TEST__?.getMindMapLayoutRunCount(),
  );

const rawScene = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __EXCALIDASH_TEST__: any }
    ).__EXCALIDASH_TEST__.getSceneElementsIncludingDeleted(),
  );

const drawRectangle = async (page: Page, x: number, y: number, width = 200, height = 80) => {
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width, y + height, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
};

const drawBoundArrow = async (
  page: Page,
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
) => {
  await page.keyboard.press("a");
  await page.mouse.move(from.x + from.width - 5, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 5, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
};

/** Border click: these rectangles are unfilled, so the interior does not hit-test as a click target. */
const selectByBorder = async (page: Page, shape: { x: number; y: number; width: number }) => {
  await page.locator("canvas.excalidraw__canvas.interactive").click({
    position: { x: shape.x + shape.width / 2, y: shape.y + 1 },
  });
};

const emptyCanvasClick = (page: Page) =>
  page.locator("canvas.excalidraw__canvas.interactive").click({ position: { x: 60, y: 650 } });

/**
 * Toggle pin via the floating toolbar -- never a keyboard shortcut (Hans
 * finding on this PR): `P` is Excalidraw's own native, unmodified
 * shortcut for the freedraw tool, and a keydown listener ambient over
 * every selection on every board would have silently eaten it everywhere,
 * not just inside an opted-into mind map the way v1's identical key
 * choice was scoped to. See `nativeFreedrawShortcutStillWorks` below for
 * the counter-proof that the native shortcut is untouched.
 */
const pinViaToolbar = async (page: Page) => {
  await page.getByTestId("mind-map-pin-button").click({ timeout: 10000 });
};

test.describe("ambient pin and collapse (NIL-593, Schnitt 3)", () => {
  test("collapse on one client is visible on another, without a layout run on either", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: `NIL593_Collapse_${Date.now()}` });
    const host = await browser.newContext();
    const guest = await browser.newContext();
    const hostPage = await openEditor(await host.newPage(), drawing.id);
    const guestPage = await openEditor(await guest.newPage(), drawing.id);

    try {
      await waitForCanvasReady(hostPage);
      await emptyCanvasClick(hostPage);
      await drawRectangle(hostPage, 400, 300);
      await drawRectangle(hostPage, 800, 300);
      const [root, child] = (await rawScene(hostPage)).filter((e: any) => e.type === "rectangle");
      await drawBoundArrow(hostPage, root, child);

      const hostBaseline = await layoutRunCount(hostPage);
      const guestBaseline = await layoutRunCount(guestPage);

      await selectByBorder(hostPage, root);
      await hostPage.getByTestId("mind-map-collapse-button").click();
      await hostPage.waitForTimeout(200);

      await expect
        .poll(async () => (await rawScene(hostPage)).find((e: any) => e.id === root.id)?.customData)
        .toMatchObject({ excalidash: { nodeState: { collapsed: true } } });
      await expect(hostPage.getByTestId("mind-map-collapse-badge")).toBeVisible();

      await expect
        .poll(
          async () => (await rawScene(guestPage)).find((e: any) => e.id === root.id)?.customData,
        )
        .toMatchObject({ excalidash: { nodeState: { collapsed: true } } });
      await expect(guestPage.getByTestId("mind-map-collapse-badge")).toBeVisible();
      // Two masks (the hidden child rectangle and the edge into it) --
      // `.first()` since `toBeVisible()` needs one element, not a count.
      await expect(guestPage.getByTestId("mind-map-collapse-mask").first()).toBeVisible();

      expect(await layoutRunCount(hostPage)).toBe(hostBaseline);
      expect(await layoutRunCount(guestPage)).toBe(guestBaseline);
    } finally {
      await host.close();
      await guest.close();
      await deleteDrawing(request, drawing.id);
    }
  });

  test("Arrange respects a pinned position and arranges the rest", async ({ page, request }) => {
    const drawing = await createDrawing(request, { name: `NIL593_Pin_${Date.now()}` });
    try {
      await openEditor(page, drawing.id);
      await waitForCanvasReady(page);
      await emptyCanvasClick(page);
      await drawRectangle(page, 400, 300); // root
      await drawRectangle(page, 800, 150); // a
      await drawRectangle(page, 800, 550); // b, far off the tidy-tree row
      const [root, a, b] = (await rawScene(page)).filter((e: any) => e.type === "rectangle");
      await drawBoundArrow(page, root, a);
      await drawBoundArrow(page, root, b);

      await selectByBorder(page, a);
      await pinViaToolbar(page);
      await expect
        .poll(async () => (await rawScene(page)).find((e: any) => e.id === a.id)?.customData)
        .toMatchObject({ excalidash: { nodeState: { pinned: true } } });

      const aBeforeArrange = (await rawScene(page)).find((e: any) => e.id === a.id);

      await selectByBorder(page, root);
      await page.getByTestId("main-menu-trigger").click();
      await page.getByTestId("menu-arrange-mind-map").click();
      await page.waitForTimeout(300);

      const afterArrange = await rawScene(page);
      const aAfter = afterArrange.find((e: any) => e.id === a.id);
      const bAfter = afterArrange.find((e: any) => e.id === b.id);
      // Pinned: exactly where it already was.
      expect(aAfter.x).toBe(aBeforeArrange.x);
      expect(aAfter.y).toBe(aBeforeArrange.y);
      // Not pinned: laid out onto the tidy-tree row Arrange always produces,
      // away from the deliberately off-row point it was drawn at.
      expect(bAfter.y).not.toBe(800);
    } finally {
      await deleteDrawing(request, drawing.id);
    }
  });

  test("one undo step per pin toggle, and per collapse toggle", async ({ page, request }) => {
    const drawing = await createDrawing(request, { name: `NIL593_Undo_${Date.now()}` });
    try {
      await openEditor(page, drawing.id);
      await waitForCanvasReady(page);
      await emptyCanvasClick(page);
      await drawRectangle(page, 400, 300);
      await drawRectangle(page, 800, 300);
      const [root, child] = (await rawScene(page)).filter((e: any) => e.type === "rectangle");
      await drawBoundArrow(page, root, child);

      await selectByBorder(page, root);
      await pinViaToolbar(page);
      await expect
        .poll(async () => (await rawScene(page)).find((e: any) => e.id === root.id)?.customData)
        .toMatchObject({ excalidash: { nodeState: { pinned: true } } });

      await page.keyboard.press("Control+z");
      await expect
        .poll(
          async () =>
            (await rawScene(page)).find((e: any) => e.id === root.id)?.customData?.excalidash
              ?.nodeState,
        )
        .toBeUndefined();

      await selectByBorder(page, root);
      await page.getByTestId("mind-map-collapse-button").click();
      await expect
        .poll(async () => (await rawScene(page)).find((e: any) => e.id === root.id)?.customData)
        .toMatchObject({ excalidash: { nodeState: { collapsed: true } } });

      await page.keyboard.press("Control+z");
      await expect
        .poll(
          async () =>
            (await rawScene(page)).find((e: any) => e.id === root.id)?.customData?.excalidash
              ?.nodeState,
        )
        .toBeUndefined();
    } finally {
      await deleteDrawing(request, drawing.id);
    }
  });

  /**
   * Break case 1 (kickoff): "gepinnt, geloescht, per Undo zurueckgeholt" --
   * explicitly marked NOT measured in the investigation, only derived from
   * source (`newElementWith`'s shallow spread never touches `customData`;
   * `restoreElement` explicitly carries it forward). MEASURED here: pin,
   * delete, undo, in a real browser. It survives.
   */
  test("break case 1 (measured): pinned, deleted, undo-restored -- the pin survives", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: `NIL593_PinDeleteUndo_${Date.now()}` });
    try {
      await openEditor(page, drawing.id);
      await waitForCanvasReady(page);
      await emptyCanvasClick(page);
      await drawRectangle(page, 400, 300);
      const [root] = (await rawScene(page)).filter((e: any) => e.type === "rectangle");

      await selectByBorder(page, root);
      await pinViaToolbar(page);
      await expect
        .poll(async () => (await rawScene(page)).find((e: any) => e.id === root.id)?.customData)
        .toMatchObject({ excalidash: { nodeState: { pinned: true } } });

      await page.keyboard.press("Delete");
      await expect
        .poll(async () => (await rawScene(page)).find((e: any) => e.id === root.id)?.isDeleted)
        .toBe(true);

      await page.keyboard.press("Control+z");
      const restored = (await rawScene(page)).find((e: any) => e.id === root.id);
      expect(restored.isDeleted).toBe(false);
      expect(restored.customData).toMatchObject({ excalidash: { nodeState: { pinned: true } } });
    } finally {
      await deleteDrawing(request, drawing.id);
    }
  });

  /**
   * Break case 2 (kickoff): "ein eingeklappter Teilbaum wird kopiert und
   * auf einem anderen Board eingefuegt." MEASURED: select the whole
   * connected pair (node + child + the bound arrow between them), copy,
   * paste onto a second, unrelated drawing. Both the collapsed flag AND
   * the real two-way arrow binding survive, with ids correctly remapped to
   * the pasted copies (verified by reading the pasted arrow's own
   * startBinding/endBinding, not merely counting elements) -- this is the
   * "bound counterpart included in the same copy" case the NIL-593
   * investigation's own `duplicateElements` reading predicted survives.
   */
  test("break case 2 (measured): a collapsed subtree copied whole onto another board keeps its state and structure", async ({
    browser,
    request,
  }) => {
    const drawingA = await createDrawing(request, { name: `NIL593_CopyA_${Date.now()}` });
    const drawingB = await createDrawing(request, { name: `NIL593_CopyB_${Date.now()}` });
    const ctx = await browser.newContext();
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    try {
      const pageA = await ctx.newPage();
      await openEditor(pageA, drawingA.id);
      await waitForCanvasReady(pageA);
      await emptyCanvasClick(pageA);
      await drawRectangle(pageA, 400, 300);
      await drawRectangle(pageA, 800, 300);
      const [root, child] = (await rawScene(pageA)).filter((e: any) => e.type === "rectangle");
      await drawBoundArrow(pageA, root, child);

      await selectByBorder(pageA, root);
      await pageA.waitForTimeout(300);
      await pageA.getByTestId("mind-map-collapse-button").click();
      await expect
        .poll(async () => (await rawScene(pageA)).find((e: any) => e.id === root.id)?.customData)
        .toMatchObject({ excalidash: { nodeState: { collapsed: true } } });

      await pageA.keyboard.press("Control+a");
      await pageA.keyboard.press("Control+c");
      await pageA.waitForTimeout(200);

      const pageB = await ctx.newPage();
      await openEditor(pageB, drawingB.id);
      await waitForCanvasReady(pageB);
      await pageB.locator("canvas.excalidraw__canvas.interactive").click({
        position: { x: 500, y: 400 },
      });
      await pageB.keyboard.press("Control+v");
      await pageB.waitForTimeout(400);

      const rectsB = (await rawScene(pageB)).filter(
        (e: any) => e.type === "rectangle" && !e.isDeleted,
      );
      expect(rectsB).toHaveLength(2);
      const collapsedCopy = rectsB.find(
        (e: any) => e.customData?.excalidash?.nodeState?.collapsed === true,
      );
      expect(collapsedCopy).toBeDefined();

      const arrowsB = (await rawScene(pageB)).filter(
        (e: any) => e.type === "arrow" && !e.isDeleted,
      );
      expect(arrowsB).toHaveLength(1);
      const arrowIds = new Set(rectsB.map((r: any) => r.id));
      expect(arrowIds.has(arrowsB[0].startBinding?.elementId)).toBe(true);
      expect(arrowIds.has(arrowsB[0].endBinding?.elementId)).toBe(true);
    } finally {
      await ctx.close();
      await deleteDrawing(request, drawingA.id);
      await deleteDrawing(request, drawingB.id);
    }
  });

  /**
   * Break case 3 (kickoff): duplicating tears `boundElements` (measured on
   * the NIL-593 Multica thread against `@excalidraw/excalidraw@0.18.1`'s
   * own `duplicateElement`: a single-element duplicate's copy gets
   * `boundElements: null`... in this fork's own measurement below, a
   * *stale* reference to the OLD arrow instead, whose own
   * `startBinding`/`endBinding` were never repointed at the duplicate --
   * either way, the duplicate ends up unconnected in the ambient graph).
   * `customData` is unconditionally deep-copied regardless. MEASURED here:
   * duplicate a pinned node bound to a child via Ctrl+D. The duplicate
   * keeps `pinned: true` but is not reachable as anyone's ambient parent or
   * child.
   *
   * Decided: no special-case cleanup, unlike the old `mapId`/`parentId`
   * relational duplication problem `useMindMapIntegrity.ts` (deleted,
   * Schnitt 2) had to actively repair. `nodeState` carries no structural
   * meaning, so state without structure is inert by construction:
   * `collapsedHiddenIds` already returns `null` for a node with no
   * qualifying ambient children (the same silence `ambientSubtreeIds`
   * gives a leaf or a decision point), so an orphaned "collapsed" duplicate
   * draws no mask, no badge -- reads as an ordinary node. An orphaned
   * "pinned" duplicate is even simpler: nothing ever calls `arrangeOps`
   * rooted at an unreachable node, so the flag has no effect until the
   * duplicate is deliberately rebound to something, at which point it
   * behaves exactly as any other pinned node would.
   */
  test("break case 3 (measured): a duplicate keeps nodeState but not its structural binding, and that is harmless", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: `NIL593_Duplicate_${Date.now()}` });
    try {
      await openEditor(page, drawing.id);
      await waitForCanvasReady(page);
      await emptyCanvasClick(page);
      await drawRectangle(page, 400, 300);
      await drawRectangle(page, 800, 300);
      const [root, child] = (await rawScene(page)).filter((e: any) => e.type === "rectangle");
      await drawBoundArrow(page, root, child);

      await selectByBorder(page, root);
      await pinViaToolbar(page);
      await expect
        .poll(async () => (await rawScene(page)).find((e: any) => e.id === root.id)?.customData)
        .toMatchObject({ excalidash: { nodeState: { pinned: true } } });

      await page.keyboard.press("Control+d");
      await page.waitForTimeout(300);

      const rects = (await rawScene(page)).filter(
        (e: any) => e.type === "rectangle" && !e.isDeleted,
      );
      expect(rects).toHaveLength(3);
      const pinnedRects = rects.filter(
        (e: any) => e.customData?.excalidash?.nodeState?.pinned === true,
      );
      // The original AND the duplicate both carry the flag: customData is
      // deep-copied unconditionally.
      expect(pinnedRects).toHaveLength(2);
      const duplicate = pinnedRects.find((e: any) => e.id !== root.id)!;

      // The duplicate is not reachable as anyone's ambient parent or
      // child: no arrow's real `startBinding`/`endBinding` (what
      // `ambientSubtreeIds`/`collapsedHiddenIds` actually walk) names it --
      // only its own stale `boundElements` entry does, which nothing here
      // reads as structure. This is what makes an orphaned pinned/collapsed
      // duplicate inert: no code path ever treats it as having qualifying
      // children.
      const allArrows = (await rawScene(page)).filter((e: any) => e.type === "arrow");
      for (const arrow of allArrows) {
        expect(arrow.startBinding?.elementId).not.toBe(duplicate.id);
        expect(arrow.endBinding?.elementId).not.toBe(duplicate.id);
      }
    } finally {
      await deleteDrawing(request, drawing.id);
    }
  });

  /**
   * Hans finding on this PR: pin used to be a `P` keyboard shortcut, and
   * `P` is Excalidraw's own native, unmodified shortcut for the freedraw
   * tool. A test that only checks pinning still works would not have
   * caught that bug -- it never exercised the native tool at all. This
   * test does exactly what the finding's own repro describes: draw a
   * rectangle (Excalidraw leaves it selected, exactly the state a stray
   * keydown listener would see), press `P`, and check the freedraw tool
   * actually armed -- not that some element got pinned.
   */
  test("pressing P after selecting a shape still arms Excalidraw's native freedraw tool (Hans finding)", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: `NIL593_NativeP_${Date.now()}` });
    try {
      await openEditor(page, drawing.id);
      await waitForCanvasReady(page);
      await emptyCanvasClick(page);
      await drawRectangle(page, 400, 300);
      const [root] = (await rawScene(page)).filter((e: any) => e.type === "rectangle");

      // Excalidraw leaves a just-drawn shape selected -- the exact
      // precondition the finding's own repro names.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__.getAppState()
                .selectedElementIds,
          ),
        )
        .toMatchObject({ [root.id]: true });

      await page.keyboard.press("p");

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__.getAppState()
                .activeTool,
          ),
        )
        .toEqual({ type: "builtin", name: "freedraw" });

      // And the shape itself was not pinned by the same keypress.
      const afterP = (await rawScene(page)).find((e: any) => e.id === root.id);
      expect(afterP.customData?.excalidash?.nodeState?.pinned).toBeUndefined();
    } finally {
      await deleteDrawing(request, drawing.id);
    }
  });
});
