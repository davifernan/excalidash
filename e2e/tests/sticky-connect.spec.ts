import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { armTool, labels, notes, openEditor, scene, toolbarButton } from "./helpers/editor";

/**
 * Reaching for the note tool, and pulling arrows out of a note.
 *
 * Both depend on markup and behaviour that Excalidraw does not promise: the
 * button is portalled into its toolbar, and an arrow is started by handing its
 * canvas a pointer event. Neither can be checked anywhere but in a browser, and
 * both fail visibly here the day a version changes underneath them.
 */

const placeNote = async (page: Page, at: { x: number; y: number }) => {
  await armTool(page);
  await page.locator("canvas").last().click({ position: at });
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__
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
    await page
      .locator("canvas")
      .last()
      .click({ position: { x: 700, y: 500 } });
    await page.keyboard.press("n");
    await page.waitForFunction(
      () => (window as any).__EXCALIDASH_TEST__.getAppState().activeTool?.customType === "sticky",
    );

    await page.keyboard.press("n");
    await page.waitForFunction(
      () => (window as any).__EXCALIDASH_TEST__.getAppState().activeTool?.type === "selection",
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

  test("previews a child, then creates and edits it with one click", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    await page.mouse.move(400, 300);
    const handle = page.getByTestId("sticky-handle-right");
    await expect(handle).toBeVisible();
    await handle.hover();
    await expect(page.getByTestId("sticky-child-preview")).toBeVisible();

    await handle.click();
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.keyboard.type("Child note");
    await page.keyboard.press("Escape");
    await settle(page);

    const created = await scene(page);
    const createdNotes = created.filter((element: any) => element.sticky);
    const arrow = created.find((element: any) => element.type === "arrow");
    expect(createdNotes).toHaveLength(2);
    expect(arrow?.startBinding?.elementId).toBe(createdNotes[0].id);
    expect(arrow?.endBinding?.elementId).toBe(createdNotes[1].id);

    const child = createdNotes[1];
    const childY = child.y;
    const childViewport = await page.evaluate(
      (point) => {
        const api = (window as any).__EXCALIDASH_TEST__;
        return api.toViewport(point);
      },
      {
        x: child.x + child.width / 2,
        y: child.y + child.height / 2,
      },
    );
    const canvasBox = await page.locator("canvas.excalidraw__canvas.interactive").boundingBox();
    if (!childViewport || !canvasBox) throw new Error("Could not locate the connected child note");
    const childPage = {
      x: canvasBox.x + childViewport.x,
      y: canvasBox.y + childViewport.y,
    };
    await page.mouse.move(childPage.x, childPage.y);
    await page.mouse.down();
    await page.mouse.move(childPage.x, childPage.y + 120, { steps: 12 });
    await page.mouse.up();
    await settle(page);
    const movedNotes = (await notes(page)).sort((a: any, b: any) => a.x - b.x);
    expect(movedNotes[1].y).toBeGreaterThan(childY + 100);
  });

  test("treats a 150ms stationary press as a click, not a drag", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    await page.mouse.move(400, 300);
    const handle = page.getByTestId("sticky-handle-right");
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();

    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    expect(await notes(page)).toHaveLength(2);
    expect((await scene(page)).filter((element: any) => element.type === "arrow")).toHaveLength(1);
  });

  test("coalesces two same-frame clicks on one handle", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    await page.mouse.move(400, 300);
    const handle = page.getByTestId("sticky-handle-right");
    await expect(handle).toBeVisible();
    await handle.evaluate((element) => {
      const dispatchClick = (pointerId: number) => {
        element.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: "mouse",
            button: 0,
            buttons: 1,
            clientX: 505,
            clientY: 300,
          }),
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId,
            pointerType: "mouse",
            button: 0,
            buttons: 0,
            clientX: 505,
            clientY: 300,
          }),
        );
      };
      dispatchClick(41);
      dispatchClick(42);
    });

    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await settle(page);
    expect(await notes(page)).toHaveLength(2);
    expect((await scene(page)).filter((element: any) => element.type === "arrow")).toHaveLength(1);
  });

  test("undoes a click-created note and arrow as one gesture", async ({ page }, testInfo) => {
    if (testInfo.project.name === "firefox" || testInfo.project.name === "webkit") {
      // NIL-640: WebKit records the parent note late, at the END of the later child text
      // edit, and folds both changes together; Undo consequently targets the parent entry.
      // A Chromium/WebKit History dump proved this, and captureUpdate: IMMEDIATELY does not fix it.
      test.fail();
    }
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    await page.mouse.move(400, 300);
    await page.getByTestId("sticky-handle-right").click();
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.locator("canvas.excalidraw__canvas.interactive").click({
      position: { x: 900, y: 500 },
    });
    await page.keyboard.press("Escape");
    await settle(page);
    await page.keyboard.press("Control+z");
    await settle(page);

    expect(await notes(page)).toHaveLength(1);
    expect((await scene(page)).filter((element: any) => element.type === "arrow")).toHaveLength(0);
  });

  test("keeps handle diameter fixed on screen across zoom levels", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    const widths: number[] = [];
    for (const zoom of [0.5, 1, 2]) {
      await page.evaluate((value) => {
        const api = (window as any).__EXCALIDASH_TEST__;
        api.updateScene({ appState: { zoom: { value } } });
      }, zoom);
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const api = (window as any).__EXCALIDASH_TEST__;
        const note = api
          .getSceneElements()
          .find((element: any) => element.customData?.excalidash?.sticky);
        api.updateScene({ appState: { selectedElementIds: { [note.id]: true } } });
      });
      await page.waitForTimeout(250);
      const handle = page.getByTestId("sticky-handle-right");
      await expect(handle).toBeVisible();
      widths.push((await handle.boundingBox())!.width);
    }

    expect(widths).toEqual([9, 9, 9]);
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

  test("stays hidden on a rotated note (NIL-276: guessed points would be worse than none)", async ({
    page,
  }) => {
    // StickyHandles bails out entirely on `note.angle` -- a deliberate choice
    // (see the file's own comment) because a wrongly rotated point is worse
    // than no point at all. This locks that suppression in as observed
    // behaviour rather than leaving it as an untested assumption; it is not a
    // request to implement rotated points.
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await escapeEditor(page);

    await page.mouse.move(400, 300);
    await expect(page.getByTestId("sticky-handle-right")).toBeVisible();

    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const elements = api.getSceneElements();
      const rotated = elements.map((element: any) =>
        element.customData?.excalidash?.sticky ? { ...element, angle: Math.PI / 6 } : element,
      );
      api.updateScene({ elements: rotated });
    });
    await page.waitForTimeout(300);
    // The hover state itself does not change; only the note's own angle does.
    // Re-issuing the same pointer position keeps the note "under the pointer"
    // in case the scene write reset a hover subscription along the way.
    await page.mouse.move(400, 300);
    await page.waitForTimeout(300);

    await expect(page.getByTestId("sticky-handle-right")).toHaveCount(0);
    await expect(page.getByTestId("sticky-handle-left")).toHaveCount(0);
    await expect(page.getByTestId("sticky-handle-top")).toHaveCount(0);
    await expect(page.getByTestId("sticky-handle-bottom")).toHaveCount(0);
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
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2);
    await page.waitForTimeout(120);
    await page.mouse.move(650, 300, { steps: 12 });
    await page.mouse.move(800, 300, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const drawn = await scene(page);
    const arrows = drawn.filter((element: any) => element.type === "arrow");
    expect(arrows).toHaveLength(1);

    const bindings = await page.evaluate(() => {
      const arrow = (window as any).__EXCALIDASH_TEST__
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
      const arrow = (window as any).__EXCALIDASH_TEST__
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
      const arrow = (window as any).__EXCALIDASH_TEST__
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

    // Place the note at the centre of the frame that actually got drawn, not at
    // a pixel that assumes the drag landed exactly. WebKit applies a synthetic
    // drag only partly and by a varying amount -- measured at 84x64, 210x160
    // and 294x224 across runs for the same 420x320 gesture -- so a fixed point
    // lands outside the frame there and the test then measures the drag rather
    // than the thing it is named after.
    const frameBox = await page.evaluate(() => {
      const frame = (window as any).__EXCALIDASH_TEST__
        .getSceneElements()
        .find((e: any) => e.type === "frame");
      return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    });
    const frameCentre = {
      x: frameBox.x + frameBox.width / 2,
      y: frameBox.y + frameBox.height / 2,
    };

    await placeNote(page, frameCentre);
    await page.keyboard.press("Escape");
    await settle(page);

    const joined = await page.evaluate(() => {
      const els = (window as any).__EXCALIDASH_TEST__.getSceneElements();
      const frame = els.find((e: any) => e.type === "frame");
      const note = els.find((e: any) => e.customData?.excalidash?.sticky);
      return { belongs: note?.frameId === frame?.id, y: note?.y };
    });
    expect(joined.belongs).toBe(true);

    // Move the frame with the keyboard rather than a drag: selecting it by its
    // name bar and pulling depends on pixel geometry that shifts with the
    // window, and this asks the same question without any of that.
    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const frame = api.getSceneElements().find((e: any) => e.type === "frame");
      api.updateScene({ appState: { selectedElementIds: { [frame.id]: true } } });
    });
    await page.waitForTimeout(300);
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    await settle(page);

    const movedTo = await page.evaluate(
      () =>
        (window as any).__EXCALIDASH_TEST__
          .getSceneElements()
          .find((e: any) => e.customData?.excalidash?.sticky)?.y,
    );
    expect(movedTo).toBeGreaterThan(joined.y);
  });

  test("belongs to the innermost frame when frames are nested", async ({ page }) => {
    // frameAt (frontend/src/sticky/stickyPlacement.ts) picks the last-drawn
    // frame whose bounds contain the note's centre -- "topmost wins" by draw
    // order, not a true parent/child relationship read from either frame.
    // Whether that agrees with what a person actually sees -- the note landing
    // in the frame drawn on top, the small one nested inside the big one -- was
    // never watched in a browser (NIL-309, NIL-278).
    await openEditor(page, drawingId);
    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    const box = (await canvas.boundingBox())!;

    await canvas.click({ position: { x: 950, y: 560 } });
    await page.keyboard.press("f");
    // The hamburger now sits on Excalidraw's normal top row, so the shape
    // properties panel begins below it and legitimately covers the old
    // x=200/y=100 start point. Start on measured clear canvas instead of
    // asking the panel to forward a synthetic drag it owns.
    await page.mouse.move(box.x + 300, box.y + 100);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(box.x + 900, box.y + 520, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const outerBox = await page.evaluate(() => {
      const frame = (window as any).__EXCALIDASH_TEST__
        .getSceneElements()
        .find((e: any) => e.type === "frame");
      return { id: frame.id, x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    });

    // WebKit only ever shrinks a synthetic drag towards its start point (see
    // the frame drag above and its sibling test's own comment on this), so a
    // second drag requested strictly inside the outer frame's *measured*
    // bounds, with a margin, lands inside it too however much it shrinks.
    const margin = Math.min(outerBox.width, outerBox.height) / 4;
    const innerStart = { x: outerBox.x + margin, y: outerBox.y + margin };
    const innerEnd = {
      x: outerBox.x + outerBox.width - margin,
      y: outerBox.y + outerBox.height - margin,
    };

    await page.keyboard.press("f");
    await page.mouse.move(box.x + innerStart.x, box.y + innerStart.y);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(box.x + innerEnd.x, box.y + innerEnd.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const frames = await page.evaluate(() =>
      (window as any).__EXCALIDASH_TEST__
        .getSceneElements()
        .filter((e: any) => e.type === "frame")
        .map((e: any) => ({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height })),
    );
    expect(frames).toHaveLength(2);
    const outer = frames.find((f: any) => f.id === outerBox.id)!;
    const inner = frames.find((f: any) => f.id !== outerBox.id)!;

    // Sanity check on the geometry this test built, before it means anything:
    // the second frame really has to sit inside the first one.
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.y).toBeGreaterThanOrEqual(outer.y);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);

    const innerCentre = { x: inner.x + inner.width / 2, y: inner.y + inner.height / 2 };
    await placeNote(page, innerCentre);
    await page.keyboard.press("Escape");
    await settle(page);

    const membership = await page.evaluate(
      () =>
        (window as any).__EXCALIDASH_TEST__
          .getSceneElements()
          .find((e: any) => e.customData?.excalidash?.sticky)?.frameId,
    );
    expect(membership).toBe(inner.id);
    expect(membership).not.toBe(outer.id);
  });
});

test.describe("two clients typing into the same note", () => {
  // NIL-273: the reconciler's `protect` option (frontend/src/utils/sync.ts,
  // wired in through useEditorCollaboration.ts's `flushRemoteUpdates`) exists
  // *because* two people editing the same note at once used to make the two
  // boards drift apart. It has 14 unit tests, and collaboration.spec.ts's
  // two-context pattern covers ordinary draw/sync/delete -- but nothing
  // exercises `protect` itself: that only happens when a remote update to an
  // element a person is *actively editing right now* arrives, and every
  // existing two-client spec syncs elements nobody is mid-edit on.
  // The scene's own copy of the label, not the open textarea: Excalidraw does
  // not resync a focused text editor from an incoming remote element, so the
  // textarea keeps showing whatever this browser is typing regardless of
  // `protect` -- reading it would make the assertion pass whether or not the
  // reconciler actually protected anything. The scene element is where a
  // remote overwrite lands (or doesn't), and it is what the *next* thing this
  // browser does -- committing the edit, resizing the note, reloading --
  // would build on top of.
  const labelTextOf = (page: Page) =>
    page.evaluate(
      () =>
        (window as any).__EXCALIDASH_TEST__.getSceneElements().find((e: any) => e.containerId)
          ?.originalText ?? null,
    );

  test("keeps this browser's in-progress typing when the other browser's edit of the same note arrives mid-keystroke", async ({
    browser,
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `e2e-sticky-protect-${Date.now()}`,
    });
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      await openEditor(page1, drawing.id);
      await openEditor(page2, drawing.id);
      await expect(page1.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
      await expect(page2.locator(".UserList__collaborator .Avatar")).toHaveCount(1);

      // Browser 1 creates the one note both will fight over, and commits a
      // starting text so a label element actually exists to reopen (Excalidraw
      // discards an empty one on blur).
      await placeNote(page1, { x: 400, y: 300 });
      await page1.keyboard.type("start");
      await page1.keyboard.press("Escape");

      // Browser 2 only knows the note exists once the live update arrives --
      // not from having drawn it itself.
      await expect
        .poll(
          () =>
            page2.evaluate(
              () =>
                (window as any).__EXCALIDASH_TEST__
                  .getSceneElements()
                  .filter((e: any) => e.customData?.excalidash?.sticky).length,
            ),
          { timeout: 15_000, intervals: [250, 500, 1_000] },
        )
        .toBe(1);

      // Both open the same note's label editor -- the literal "two people at
      // the same note" scenario the ticket describes.
      const canvas1 = page1.locator("canvas").last();
      const canvas2 = page2.locator("canvas").last();
      await canvas1.dblclick({ position: { x: 400, y: 300 } });
      await canvas2.dblclick({ position: { x: 400, y: 300 } });
      await expect(page1.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
      await expect(page2.locator("textarea.excalidraw-wysiwyg")).toBeVisible();

      await page1.keyboard.press("Control+A");
      await page1.keyboard.type("AAAAAAAAAA");
      await page2.keyboard.press("Control+A");
      await page2.keyboard.type("BBBBBBBBBB");

      // Give the throttled socket broadcast (100ms, useEditorBroadcast.ts)
      // plenty of room to have delivered browser 2's edit to browser 1 by
      // now, while browser 1 is still typing. Not asserting browser 1's scene
      // copy still reads "AAAAAAAAAA" here: re-editing an *existing* label is
      // its own Excalidraw quirk independent of collaboration entirely --
      // the persisted copy sits decoupled from the live textarea (and can
      // legitimately read empty) until the edit commits, protected or not.
      // What `protect` actually promises, and the only thing solely under its
      // control, is that browser 2's competing content does not land here.
      await page1.waitForTimeout(600);
      expect(await labelTextOf(page1)).not.toBe("BBBBBBBBBB");

      // Browser 2 commits first -- its version of the label is now the one
      // sitting on the server and broadcast out, arriving at browser 1 while
      // browser 1 is *still* mid-edit of the very same element.
      await page2.keyboard.press("Escape");
      await page1.waitForTimeout(600);
      expect(await labelTextOf(page1)).not.toBe("BBBBBBBBBB");

      // Only once browser 1 also commits does its own edit stop being held.
      // Which of the two texts the reconciler keeps from here is a genuine
      // tie -- both clients reach the same version count from the same
      // starting element, so the deterministic versionNonce tie-break in
      // reconcileElements (sync.ts) decides it, not this test. What the test
      // asks is the thing `protect` actually promises: no permanent split.
      // Both clients must settle on the *same* one of the two answers.
      await page1.keyboard.press("Escape");
      await expect
        .poll(
          async () => {
            const [a, b] = await Promise.all([labelTextOf(page1), labelTextOf(page2)]);
            return a !== null && a === b ? a : null;
          },
          { timeout: 15_000, intervals: [250, 500, 1_000] },
        )
        .not.toBeNull();
      const converged = await labelTextOf(page1);
      expect(["AAAAAAAAAA", "BBBBBBBBBB"]).toContain(converged);
      expect(await labelTextOf(page2)).toBe(converged);
    } finally {
      await context1.close();
      await context2.close();
      await deleteDrawing(request, drawing.id).catch(() => {});
    }
  });
});
