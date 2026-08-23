import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { armTool, labels, notes, openEditor, scene, toolbarButton } from "./helpers/editor";

/**
 * Sticky notes, in a real browser.
 *
 * The unit tests measure text through a stand-in, because jsdom has no fonts.
 * Everything that only holds with the real thing is checked here: that the
 * button reaches the canvas at all, that the label editor actually opens from
 * the Enter this code sends — the one step with no public API — and that a long
 * note shrinks its writing against real font metrics rather than growing.
 */

const stickyButton = (page: Page) => toolbarButton(page, "sticky");

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

test.describe("sticky notes", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-sticky-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("puts a note on the board where it was clicked", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });

    const placed = await notes(page);
    expect(placed).toHaveLength(1);
    expect(placed[0].type).toBe("rectangle");
    expect(placed[0].width).toBe(200);
    expect(placed[0].height).toBe(200);
  });

  test("says nothing while doing it", async ({ page }) => {
    // A note used to announce itself with "press Enter to type in it" — advice
    // that arrived while the cursor was already blinking in the note, because
    // the check behind it read the editor state a frame too early. Placing a
    // note is not an event worth interrupting anyone for.
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await page.keyboard.type("Quiet");
    await page.keyboard.press("Escape");
    await settle(page);

    // Nothing of ours pops up...
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    // ...and Excalidraw's own "Press Enter to add text" stays out of the way
    // too, which on a note is advice for something that already happened.
    await expect(page.getByText(/press Enter/i)).toBeHidden();
  });

  test("leaves the editor's hint alone for everything else", async ({ page, isMobile }) => {
    // Fixed canvas coordinates chosen for a 1280x720 window. On a phone that
    // point sits under Excalidraw's own tool row, so the click never reaches
    // the canvas. Skipped rather than moved: a mobile-safe point would
    // quietly turn this into a different test. The mobile contract is carried
    // by the cases that place a note through the tool rather than at a pixel.
    test.skip(isMobile === true, "fixed desktop canvas coordinates");

    await openEditor(page, drawingId);
    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: 950, y: 520 } });
    await page.keyboard.press("r");
    await page.mouse.move(box.x + 420, box.y + 140);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(box.x + 620, box.y + 300, { steps: 10 });
    await page.mouse.up();
    await settle(page);

    // A plain rectangle still gets told what Enter does.
    await expect(page.getByText(/press Enter/i)).toBeVisible();
  });

  test("opens the label editor by itself, so typing starts straight away", async ({ page }) => {
    // The step with no public API. If Excalidraw ever stops starting its editor
    // from a synthetic Enter, this is what says so.
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });

    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible({ timeout: 5000 });

    await page.keyboard.type("Deploy on Friday");
    await page.keyboard.press("Escape");
    await settle(page);

    const written = await labels(page);
    expect(written).toHaveLength(1);
    expect(written[0].text).toContain("Deploy on Friday");
  });

  test("shrinks the writing rather than growing the note", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();

    await page.keyboard.type(
      "This note has considerably more in it than a couple of words, enough that " +
        "the writing has to give way if the paper is to stay the size it was.",
    );
    await page.keyboard.press("Escape");
    await settle(page);

    const [note] = await notes(page);
    const [label] = await labels(page);
    expect(note.height).toBe(200);
    expect(note.width).toBe(200);
    expect(label.fontSize).toBeLessThan(20);
  });

  test("keeps a short note at its full size", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();

    await page.keyboard.type("Ship it");
    await page.keyboard.press("Escape");
    await settle(page);

    const [label] = await labels(page);
    expect(label.fontSize).toBe(20);
  });

  test("Tab makes the next note beside the one selected", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.keyboard.type("First");
    await page.keyboard.press("Escape");
    await settle(page);

    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () =>
        (window as any).__EXCALIDASH_TEST__
          .getSceneElements()
          .filter((element: any) => element.customData?.excalidash?.sticky).length === 2,
      undefined,
      { timeout: 5000 },
    );

    const placed = await notes(page);
    const [first, second] = placed.sort((a: any, b: any) => a.x - b.x);
    expect(second.x - (first.x + first.width)).toBe(24);
    expect(second.y).toBe(first.y);
  });

  test("puts the chosen colour on the paper", async ({ page }) => {
    await openEditor(page, drawingId);
    await armTool(page);
    await page.getByRole("button", { name: "Blue" }).click();
    await page.locator("canvas").last().click({ position: { x: 400, y: 300 } });
    await page.waitForFunction(() =>
      (window as any).__EXCALIDASH_TEST__
        .getSceneElements()
        .some((element: any) => element.customData?.excalidash?.sticky),
    );

    const [note] = await notes(page);
    expect(note.backgroundColor).toBe("#bfdbfe");
    expect(note.sticky.color).toBe("blue");
  });

  test("survives a reload with its size and metadata intact", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.keyboard.type("Persisted");
    await page.keyboard.press("Escape");
    await settle(page);
    await page.waitForTimeout(1500);

    await openEditor(page, drawingId);
    await settle(page);

    const placed = await notes(page);
    expect(placed).toHaveLength(1);
    expect(placed[0].height).toBe(200);
    expect(placed[0].sticky).toMatchObject({ color: "yellow" });
    expect(placed[0].schemaVersion).toBe(2);
    const [label] = await labels(page);
    expect(label.text).toContain("Persisted");
  });

  test("settles instead of drifting when left alone", async ({ page }) => {
    // The upkeep runs on every scene change and updates the scene. If it were
    // not still, a note would gain a revision per frame forever.
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.keyboard.type("Quiet please");
    await page.keyboard.press("Escape");
    await settle(page);

    const versionOf = () =>
      page.evaluate(
        () =>
          (window as any).__EXCALIDASH_TEST__
            .getSceneElements()
            .find((element: any) => element.containerId)?.version ?? 0,
      );

    const before = await versionOf();
    await page.waitForTimeout(2000);
    expect(await versionOf()).toBe(before);
  });
});

test.describe("where a new note lands in the stack", () => {
  let drawingId: string;
  let api: APIRequestContext;

  const rect = (id: string, index: string, x: number) => ({
    id, type: "rectangle", x, y: 200, width: 120, height: 120, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100,
    seed: 1, version: 1, versionNonce: 1, index, isDeleted: false,
    groupIds: [], frameId: null, roundness: null, boundElements: null,
    updated: 1, link: null, locked: false,
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("goes on top without disturbing the order of what is already there", async ({
    page,
    request,
    isMobile,
  }) => {
    // Fixed canvas coordinates chosen for a 1280x720 window. On a phone that
    // point sits under Excalidraw's own tool row, so the click never reaches
    // the canvas. Skipped rather than moved: a mobile-safe point would
    // quietly turn this into a different test. The mobile contract is carried
    // by the cases that place a note through the tool rather than at a pixel.
    test.skip(isMobile === true, "fixed desktop canvas coordinates");

    api = request;
    const drawing = await createDrawing(request, {
      name: `e2e-sticky-z-${Date.now()}`,
      elements: [rect("r1", "a1", 300), rect("r2", "a2", 500), rect("r3", "a3", 700)],
    });
    drawingId = drawing.id;

    await openEditor(page, drawingId);
    await settle(page);
    await page.locator("canvas").last().click({ position: { x: 950, y: 520 } });
    await placeNote(page, { x: 560, y: 260 });
    await page.keyboard.press("Escape");
    await settle(page);

    const stack = await page.evaluate(() =>
      (window as any).__EXCALIDASH_TEST__
        .getSceneElements()
        .filter((e: any) => !e.isDeleted)
        .map((e: any) => [
          e.customData?.excalidash?.sticky ? "NOTE" : e.id,
          e.index,
        ]),
    );

    // The three that were there keep the indices they came with...
    expect(stack.slice(0, 3)).toEqual([
      ["r1", "a1"],
      ["r2", "a2"],
      ["r3", "a3"],
    ]);
    // ...and the note is above all of them.
    expect(stack[3][0]).toBe("NOTE");
    expect(stack[3][1] > "a3").toBe(true);
  });

  test("each note lands above the one before it", async ({ page, request, isMobile }) => {
    // Fixed canvas coordinates chosen for a 1280x720 window. On a phone that
    // point sits under Excalidraw's own tool row, so the click never reaches
    // the canvas. Skipped rather than moved: a mobile-safe point would
    // quietly turn this into a different test. The mobile contract is carried
    // by the cases that place a note through the tool rather than at a pixel.
    test.skip(isMobile === true, "fixed desktop canvas coordinates");

    api = request;
    const drawing = await createDrawing(request, {
      name: `e2e-sticky-stack-${Date.now()}`,
      elements: [],
    });
    drawingId = drawing.id;

    await openEditor(page, drawingId);
    await page.locator("canvas").last().click({ position: { x: 950, y: 520 } });
    for (const at of [
      { x: 500, y: 220 },
      { x: 560, y: 260 },
      { x: 620, y: 300 },
    ]) {
      await placeNote(page, at);
      await page.keyboard.press("Escape");
      await settle(page);
    }

    const notes = await page.evaluate(() =>
      (window as any).__EXCALIDASH_TEST__
        .getSceneElements()
        .filter((e: any) => e.customData?.excalidash?.sticky)
        .map((e: any) => e.index),
    );
    expect(notes).toHaveLength(3);
    expect([...notes].sort()).toEqual(notes);
  });
});
