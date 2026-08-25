import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene } from "./helpers/editor";

/**
 * Ambient tree drag (NIL-593, first delivery slice).
 *
 * No tool, no mode, no customData: dragging a box takes along whatever it
 * points to via a real, native bound arrow (`startBinding`/`endBinding`),
 * recursively. The pure decision (`ambientSubtreeIds`) has its own
 * DOM-free fixture-corpus tests in `frontend/src/ambientTree/ambientTree.test.ts`
 * -- what only holds with the real editor is checked here: a real pointer
 * drag actually moves the whole bound subtree, an EXISTING flowchart board
 * stays completely unaffected at its real branch/merge point, a cycle
 * demonstrably does nothing, dragging is one undo step, and -- the same
 * central collaboration promise NIL-570 already established -- this never
 * triggers a layout run on this client or another.
 */

const waitForCanvasReady = async (page: Page) => {
  await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
};

/** A rectangle with the given top-left and size, via the plain toolbar tool (no mind-map, no sticky). */
const drawRectangle = async (page: Page, x: number, y: number, width = 200, height = 80) => {
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width, y + height, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
};

/** A bound arrow from the right edge of `from` to the left edge of `to` -- both real Excalidraw shapes, both edges within binding range. */
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

/** Select `shape` by clicking its (unfilled, so border-only) edge, then drag it by (dx, dy). */
const dragShapeByBorder = async (
  page: Page,
  shape: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
) => {
  const from = { x: shape.x + shape.width / 2, y: shape.y + 1 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
};

const rectangles = async (page: Page) =>
  (await scene(page)).filter((element: any) => element.type === "rectangle");
const arrows = async (page: Page) =>
  (await scene(page)).filter((element: any) => element.type === "arrow");

const layoutRunCount = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__?.getMindMapLayoutRunCount(),
  );

test.describe("ambient tree drag", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-ambient-tree-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("dragging a box takes along whatever it points to, recursively", async ({ page }) => {
    await openEditor(page, drawingId);
    await waitForCanvasReady(page);
    await page.locator("canvas").last().click({ position: { x: 1100, y: 600 } });

    // Root(400,300) -> A(800,150) -> A1(1200,150); Root -> B(800,450).
    await drawRectangle(page, 400, 300);
    await drawRectangle(page, 800, 150);
    await drawRectangle(page, 1200, 150);
    await drawRectangle(page, 800, 450);

    const [root, a, a1, b] = await rectangles(page);
    await drawBoundArrow(page, root, a);
    await drawBoundArrow(page, a, a1);
    await drawBoundArrow(page, root, b);

    const before = await rectangles(page);
    const beforeById = new Map(before.map((r: any) => [r.id, { x: r.x, y: r.y }]));
    // The A -> A1 arrow: wholly INSIDE the translated subtree, neither end
    // is the natively-dragged root.
    const internalArrowBefore = (await arrows(page)).find(
      (ar: any) => ar.startBinding?.elementId === a.id && ar.endBinding?.elementId === a1.id,
    )!;

    await dragShapeByBorder(page, before.find((r: any) => r.id === root.id), 40, -30);

    const after = await rectangles(page);
    // The root's own delta comes from Excalidraw's native drag, which does
    // not always land pixel-exact for a synthetic multi-step mouse move
    // (grid snap, easing) -- what this test checks is that every OTHER box
    // moved by exactly the SAME delta root actually achieved, not a
    // hardcoded expectation of root's own landing spot.
    const rootAfter = after.find((r: any) => r.id === root.id)!;
    const rootBefore = beforeById.get(root.id)!;
    const actualDx = rootAfter.x - rootBefore.x;
    const actualDy = rootAfter.y - rootBefore.y;
    expect(Math.abs(actualDx - 40)).toBeLessThan(10);
    expect(Math.abs(actualDy - -30)).toBeLessThan(10);
    for (const r of after) {
      const start = beforeById.get(r.id)!;
      expect(r.x - start.x).toBeCloseTo(actualDx, -1);
      expect(r.y - start.y).toBeCloseTo(actualDy, -1);
    }

    /**
     * Excalidraw does NOT reflow an arrow's geometry on its own when
     * neither of its bound endpoints is the natively-dragged shape --
     * measured, not assumed (see `useAmbientTreeDrag.ts`'s own file
     * comment: the very first version of this hook left exactly this arrow
     * floating, visibly detached from both boxes, in a real screenshot).
     * Counter-test: an implementation that patches only the boxes and
     * skips this arrow's own translation would leave `x`/`y` completely
     * UNCHANGED from before the drag -- copied here as `unchangedArrow`,
     * not `git checkout --`'d, per NIL-570's evidence rule.
     */
    const internalArrowAfter = (await arrows(page)).find((ar: any) => ar.id === internalArrowBefore.id)!;
    const unchangedArrow = { x: internalArrowBefore.x, y: internalArrowBefore.y }; // the bug
    expect(unchangedArrow.x).not.toBeCloseTo(internalArrowAfter.x, -1);
    expect(internalArrowAfter.x - internalArrowBefore.x).toBeCloseTo(actualDx, -1);
    expect(internalArrowAfter.y - internalArrowBefore.y).toBeCloseTo(actualDy, -1);
  });

  test("dragging a middle node pulls only its own descendants", async ({ page }) => {
    await openEditor(page, drawingId);
    await waitForCanvasReady(page);
    await page.locator("canvas").last().click({ position: { x: 1100, y: 600 } });

    await drawRectangle(page, 400, 300); // root
    await drawRectangle(page, 800, 150); // a
    await drawRectangle(page, 1200, 150); // a1

    const [root, a, a1] = await rectangles(page);
    await drawBoundArrow(page, root, a);
    await drawBoundArrow(page, a, a1);

    const before = await rectangles(page);
    const rootBefore = before.find((r: any) => r.id === root.id);
    const aBefore = before.find((r: any) => r.id === a.id);
    const a1Before = before.find((r: any) => r.id === a1.id);

    await dragShapeByBorder(page, aBefore, 60, 60);

    const after = await rectangles(page);
    const rootAfter = after.find((r: any) => r.id === root.id);
    const a1After = after.find((r: any) => r.id === a1.id);
    expect(rootAfter.x).toBeCloseTo(rootBefore.x, -1);
    expect(rootAfter.y).toBeCloseTo(rootBefore.y, -1);
    expect(a1After.x - a1Before.x).toBeCloseTo(60, -1);
    expect(a1After.y - a1Before.y).toBeCloseTo(60, -1);
  });

  /**
   * The ticket's own most important piece of evidence: a realistic
   * flowchart with a genuine decision point stays completely unaffected.
   * Start -> Decision -> {Yes down, No right} -> both merge into End.
   */
  test("an existing flowchart board is unaffected: dragging its decision point moves nothing else", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    await waitForCanvasReady(page);
    await page.locator("canvas").last().click({ position: { x: 60, y: 650 } });

    // Shifted clear of the left property panel (roughly x < 220 once a tool
    // is armed) and sized to stay within the 1280-wide viewport.
    await drawRectangle(page, 260, 150, 150, 60); // start
    await drawRectangle(page, 560, 150, 150, 60); // decision
    await drawRectangle(page, 560, 500, 150, 60); // yes (straight down from decision)
    await drawRectangle(page, 900, 150, 150, 60); // no (to the right of decision)
    await drawRectangle(page, 900, 500, 150, 60); // end (merge point)

    const [start, decision, yes, no, end] = await rectangles(page);
    await drawBoundArrow(page, start, decision);
    await drawBoundArrow(page, decision, yes);
    await drawBoundArrow(page, decision, no);
    await drawBoundArrow(page, yes, end);
    await drawBoundArrow(page, no, end);

    const before = await rectangles(page);
    const beforeById = new Map(before.map((r: any) => [r.id, { x: r.x, y: r.y }]));

    await dragShapeByBorder(page, before.find((r: any) => r.id === decision.id), 80, 80);

    const after = await rectangles(page);
    // Everything except Decision itself is exactly where it started.
    for (const r of after) {
      if (r.id === decision.id) continue;
      const start2 = beforeById.get(r.id)!;
      expect(r.x).toBeCloseTo(start2.x, -1);
      expect(r.y).toBeCloseTo(start2.y, -1);
    }
  });

  test("a cycle (A -> B -> C -> A) demonstrably does nothing beyond the dragged shape itself", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    await waitForCanvasReady(page);
    await page.locator("canvas").last().click({ position: { x: 60, y: 650 } });

    await drawRectangle(page, 300, 200); // a
    await drawRectangle(page, 700, 200); // b
    await drawRectangle(page, 700, 600); // c

    const [a, b, c] = await rectangles(page);
    await drawBoundArrow(page, a, b);
    await drawBoundArrow(page, b, c);
    await drawBoundArrow(page, c, a); // closes the cycle

    const before = await rectangles(page);
    const beforeById = new Map(before.map((r: any) => [r.id, { x: r.x, y: r.y }]));

    await dragShapeByBorder(page, before.find((r: any) => r.id === a.id), 90, 40);

    const after = await rectangles(page);
    // B and C never moved -- only A (the directly dragged shape) did.
    for (const r of after) {
      if (r.id === a.id) continue;
      const start = beforeById.get(r.id)!;
      expect(r.x).toBeCloseTo(start.x, -1);
      expect(r.y).toBeCloseTo(start.y, -1);
    }
  });

  test("two arrows into the same box: neither claimed parent drags it", async ({ page }) => {
    await openEditor(page, drawingId);
    await waitForCanvasReady(page);
    await page.locator("canvas").last().click({ position: { x: 60, y: 650 } });

    await drawRectangle(page, 300, 150); // p1
    await drawRectangle(page, 300, 550); // p2
    await drawRectangle(page, 700, 350); // shared

    const [p1, p2, shared] = await rectangles(page);
    await drawBoundArrow(page, p1, shared);
    await drawBoundArrow(page, p2, shared);

    const before = await rectangles(page);
    const sharedBefore = before.find((r: any) => r.id === shared.id);

    await dragShapeByBorder(page, before.find((r: any) => r.id === p1.id), 50, 0);

    let after = await rectangles(page);
    let sharedAfter = after.find((r: any) => r.id === shared.id);
    expect(sharedAfter.x).toBeCloseTo(sharedBefore.x, -1);
    expect(sharedAfter.y).toBeCloseTo(sharedBefore.y, -1);

    await dragShapeByBorder(page, after.find((r: any) => r.id === p2.id), 0, 50);

    after = await rectangles(page);
    sharedAfter = after.find((r: any) => r.id === shared.id);
    expect(sharedAfter.x).toBeCloseTo(sharedBefore.x, -1);
    expect(sharedAfter.y).toBeCloseTo(sharedBefore.y, -1);
  });

  test("one drag of a node with a bound child, one Ctrl+Z, and both are back", async ({ page }) => {
    await openEditor(page, drawingId);
    await waitForCanvasReady(page);
    await page.locator("canvas").last().click({ position: { x: 60, y: 650 } });

    await drawRectangle(page, 400, 300);
    await drawRectangle(page, 800, 300);
    const [parent, child] = await rectangles(page);
    await drawBoundArrow(page, parent, child);

    const before = await rectangles(page);
    const parentBefore = before.find((r: any) => r.id === parent.id);
    const childBefore = before.find((r: any) => r.id === child.id);

    await dragShapeByBorder(page, parentBefore, 70, 70);

    const dragged = await rectangles(page);
    expect(dragged.find((r: any) => r.id === child.id).x - childBefore.x).toBeCloseTo(70, -1);

    await page.mouse.move(1400, 700);
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");
    await page.waitForTimeout(300);

    const restored = await rectangles(page);
    const parentRestored = restored.find((r: any) => r.id === parent.id);
    const childRestored = restored.find((r: any) => r.id === child.id);
    expect(parentRestored.x).toBeCloseTo(parentBefore.x, -1);
    expect(parentRestored.y).toBeCloseTo(parentBefore.y, -1);
    expect(childRestored.x).toBeCloseTo(childBefore.x, -1);
    expect(childRestored.y).toBeCloseTo(childBefore.y, -1);
  });

  test("draws a real two-way bound arrow (startBinding/endBinding, boundElements)", async ({ page }) => {
    await openEditor(page, drawingId);
    await waitForCanvasReady(page);
    await page.locator("canvas").last().click({ position: { x: 60, y: 650 } });

    await drawRectangle(page, 400, 300);
    await drawRectangle(page, 800, 300);
    const [a, b] = await rectangles(page);
    await drawBoundArrow(page, a, b);

    const [arrow] = await arrows(page);
    expect(arrow.startBinding?.elementId).toBe(a.id);
    expect(arrow.endBinding?.elementId).toBe(b.id);

    const rectsAfter = await rectangles(page);
    const aAfter = rectsAfter.find((r: any) => r.id === a.id);
    const bAfter = rectsAfter.find((r: any) => r.id === b.id);
    expect(aAfter.boundElements?.some((ref: any) => ref.id === arrow.id)).toBe(true);
    expect(bAfter.boundElements?.some((ref: any) => ref.id === arrow.id)).toBe(true);
  });

  /**
   * The same central collaboration promise NIL-570 already established,
   * re-verified for the ambient behavior: it never triggers a layout run,
   * on this client or on another one that merely receives the result.
   */
  test("an ambient drag on one client converges on another without a layout run on either", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await openEditor(await ctxA.newPage(), drawingId);
    const pageB = await openEditor(await ctxB.newPage(), drawingId);
    await waitForCanvasReady(pageA);
    await pageA.locator("canvas").last().click({ position: { x: 60, y: 650 } });

    await drawRectangle(pageA, 400, 300);
    await drawRectangle(pageA, 800, 300);
    const [parent, child] = await rectangles(pageA);
    await drawBoundArrow(pageA, parent, child);

    await pageB.waitForFunction(
      () => (window as any).__EXCALIDASH_TEST__?.getSceneElements().length >= 3,
      { timeout: 15000 },
    );
    const baselineA = await layoutRunCount(pageA);
    const baselineB = await layoutRunCount(pageB);

    const before = await rectangles(pageA);
    const parentBefore = before.find((r: any) => r.id === parent.id);
    const childBefore = before.find((r: any) => r.id === child.id);

    await dragShapeByBorder(pageA, parentBefore, 100, -50);

    // Wait for whatever delta A's native drag actually achieved (it does
    // not always land pixel-exact for a synthetic multi-step mouse move --
    // see the "dragging a box..." test's own comment on this) to arrive on
    // B, rather than a hardcoded expected delta.
    const parentAfterA = (await rectangles(pageA)).find((r: any) => r.id === parent.id)!;
    const achievedDx = parentAfterA.x - parentBefore.x;
    await pageB.waitForFunction(
      (expected) => {
        const el = (window as any).__EXCALIDASH_TEST__?.getSceneElements()
          .find((e: any) => e.id === expected.id);
        return el && Math.round(el.x) === Math.round(expected.x);
      },
      { id: child.id, x: childBefore.x + achievedDx },
      { timeout: 15000 },
    );

    expect(await layoutRunCount(pageA)).toBe(baselineA);
    expect(await layoutRunCount(pageB)).toBe(baselineB);

    await ctxA.close();
    await ctxB.close();
  });
});
