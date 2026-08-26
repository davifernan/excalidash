import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor, scene } from "./helpers/editor";

/**
 * NIL-593, Schnitt 2: the mind-map tool's own mode is torn down. This spec
 * covers exactly the Nachweispflicht the kickoff names, distinct from
 * `ambient-tree-drag.spec.ts` (Schnitt 1's own drag-follow proof, which
 * this schnitt did not change):
 *
 * 1. An existing board with old `customData.excalidash.mindMap` data
 *    loads and stays usable.
 * 2. "Import mind map..." produces ordinary elements -- no term "mind map"
 *    anywhere in what gets read back -- and Schnitt 1's ambient drag
 *    already follows them, unmodified.
 * 3. One undo step per import.
 * 4. `getMindMapLayoutRunCount` stays at 0 for a second collaborator who
 *    only received the import over the socket, never ran a command
 *    itself.
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

/** Raw scene read (customData/isDeleted included) -- `scene()` (helpers/editor.ts)
 * deliberately narrows to a stable field set neither of this file's checks fit. */
const rawScene = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __EXCALIDASH_TEST__: any }
    ).__EXCALIDASH_TEST__.getSceneElementsIncludingDeleted(),
  );

/**
 * The exact shape a v1 board carries in stored JSON: a root and a child
 * rectangle, real bound text, a real bound arrow between them
 * (NIL-575 -- the v1 tool's own edges were already native bindings before
 * this teardown), and the dying `customData.excalidash.mindMap` relation
 * on both nodes (`mapId`/`parentId`/`orderKey`, plus `pinned`/`collapsed`
 * on the root to prove the nodeState migration fallback doesn't crash
 * anything even though nothing reads it yet in this schnitt).
 */
const legacyBoardElements = () => {
  const rootId = "legacy-root";
  const childId = "legacy-child";
  const labelRootId = "legacy-root-label";
  const labelChildId = "legacy-child-label";
  const arrowId = "legacy-arrow";
  const mapId = "legacy-map-1";

  const rect = (id: string, x: number, y: number, boundElements: any[]) => ({
    id,
    type: "rectangle",
    x,
    y,
    width: 200,
    height: 80,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    roundness: { type: 3 },
    opacity: 100,
    groupIds: [],
    frameId: null,
    isDeleted: false,
    boundElements,
    updated: 1,
    seed: 1,
    version: 1,
    versionNonce: 1,
    link: null,
    locked: false,
    customData: {
      excalidash: {
        schemaVersion: 2,
        mindMap: { mapId, parentId: id === rootId ? null : rootId, orderKey: "0001", pinned: true },
      },
    },
  });

  const label = (id: string, containerId: string, x: number, y: number, text: string) => ({
    id,
    type: "text",
    x,
    y,
    width: 60,
    height: 25,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    seed: 1,
    version: 1,
    versionNonce: 1,
    link: null,
    locked: false,
    text,
    fontSize: 20,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId,
    originalText: text,
    lineHeight: 1.25,
    customData: null,
  });

  const arrow = {
    id: arrowId,
    type: "arrow",
    x: 200,
    y: 40,
    width: 200,
    height: 0,
    angle: 0,
    strokeColor: "#868e96",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    seed: 1,
    version: 1,
    versionNonce: 1,
    link: null,
    locked: false,
    points: [
      [0, 0],
      [200, 0],
    ],
    lastCommittedPoint: null,
    startBinding: { elementId: rootId, focus: 0, gap: 4 },
    endBinding: { elementId: childId, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: "arrow",
    customData: {
      excalidash: { schemaVersion: 2, mindMapProjection: { mapId, childId } },
    },
  };

  return [
    rect(rootId, 0, 0, [
      { id: labelRootId, type: "text" },
      { id: arrowId, type: "arrow" },
    ]),
    label(labelRootId, rootId, 20, 27, "Root"),
    rect(childId, 400, 0, [{ id: labelChildId, type: "text" }]),
    label(labelChildId, childId, 420, 27, "Child"),
    arrow,
  ];
};

test("an existing board with old mind-map data loads and stays usable", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, {
    name: `NIL593_LegacyBoard_${Date.now()}`,
    elements: legacyBoardElements(),
  });

  try {
    await openEditor(page, drawing.id);
    await waitForCanvasReady(page);

    const elements = await scene(page);
    const rectangles = elements.filter((element: any) => element.type === "rectangle");
    expect(rectangles).toHaveLength(2);

    // Still fully editable: draw a fresh shape, confirm the board accepts it.
    await page
      .locator("canvas.excalidraw__canvas.interactive")
      .click({ position: { x: 700, y: 400 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("r");
    await page.mouse.move(700, 400);
    await page.mouse.down();
    await page.mouse.move(850, 480, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const afterDraw = await scene(page);
    expect(afterDraw.filter((element: any) => element.type === "rectangle")).toHaveLength(3);
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});

test("import creates ordinary elements the ambient tree already follows, in one undo step, no extra layout run elsewhere", async ({
  browser,
  request,
}) => {
  const drawing = await createDrawing(request, { name: `NIL593_Import_${Date.now()}` });
  const host = await browser.newContext();
  const guest = await browser.newContext();
  const hostPage = await openEditor(await host.newPage(), drawing.id);
  // Opened live, before the import, the same shape
  // `ambient-tree-drag.spec.ts`'s own convergence test uses: the guest
  // receives the change over the socket as it happens, rather than this
  // test depending on the debounced save-to-DB round trip a page opened
  // AFTER the write would need to wait on.
  const guestPage = await openEditor(await guest.newPage(), drawing.id);

  try {
    await hostPage.getByTestId("main-menu-trigger").click();
    await hostPage.getByTestId("menu-import-mind-map").click();
    await hostPage.getByTestId("mind-map-import-textarea").fill("Root\n  Child A\n  Child B");
    await hostPage.getByTestId("mind-map-import-preview").click();
    await expect(hostPage.getByTestId("mind-map-import-preview-result")).toBeVisible();
    await hostPage.getByTestId("mind-map-import-confirm").click();

    await expect
      .poll(
        async () =>
          (await scene(hostPage)).filter((element: any) => element.type === "rectangle").length,
      )
      .toBe(3);
    const hostElements = await scene(hostPage);
    const rectangles = hostElements.filter((element: any) => element.type === "rectangle");
    const arrows = hostElements.filter((element: any) => element.type === "arrow");
    expect(arrows).toHaveLength(2);

    // Nothing written anywhere knows the term "mind map" -- no relationship
    // customData on any imported element.
    for (const element of await rawScene(hostPage)) {
      const excalidash = (element as any).customData?.excalidash;
      expect(excalidash?.mindMap).toBeUndefined();
      expect(excalidash?.mindMapProjection).toBeUndefined();
    }

    // One undo step: undo once removes the whole import. (60,650): the
    // same proven-empty click point `ambient-tree-drag.spec.ts` uses --
    // (1200,700) sits under the workshop timer corner widget and hung the
    // click's own actionability wait forever, the exact NIL-330 failure
    // shape (a covered/obstructed target, not a broken app).
    await hostPage
      .locator("canvas.excalidraw__canvas.interactive")
      .click({ position: { x: 900, y: 500 } });
    await hostPage.keyboard.press("Escape");
    await hostPage.waitForTimeout(500);
    await hostPage.keyboard.press("Control+z");
    await expect
      .poll(
        async () => (await rawScene(hostPage)).filter((element: any) => !element.isDeleted).length,
      )
      .toBe(0);
    await hostPage.keyboard.press("Control+Shift+z");
    await expect
      .poll(
        async () =>
          (await scene(hostPage)).filter((element: any) => element.type === "rectangle").length,
      )
      .toBe(3);

    // Convergence, and the central promise NIL-570 already established,
    // unmodified by this schnitt: a second collaborator who only receives
    // the import (and the undo/redo around it) over the socket -- opened
    // live before the write, same as `ambient-tree-drag.spec.ts`'s own
    // convergence test, so this assertion isn't at the mercy of the
    // debounced save-to-DB round trip a page opened after the write would
    // depend on -- never runs layout itself.
    await expect
      .poll(
        async () =>
          (await scene(guestPage)).filter((element: any) => element.type === "rectangle").length,
      )
      .toBe(3);
    expect(await layoutRunCount(guestPage)).toBe(0);

    // Schnitt 1's ambient drag (`ambient-tree-drag.spec.ts`) already proves
    // a real pointer drag follows real bound arrows end to end -- not
    // re-simulated here. What THIS schnitt has to prove is that import
    // produces exactly that shape: every arrow's startBinding/endBinding
    // names a real imported rectangle id, which is the only thing ambient
    // drag actually reads to decide what follows what.
    const rectangleIds = new Set(rectangles.map((element: any) => element.id));
    for (const edge of arrows) {
      const rawArrow = (await rawScene(hostPage)).find(
        (element: any) => element.id === (edge as any).id,
      );
      expect(rectangleIds.has(rawArrow.startBinding?.elementId)).toBe(true);
      expect(rectangleIds.has(rawArrow.endBinding?.elementId)).toBe(true);
    }
  } finally {
    await host.close();
    await guest.close();
    await deleteDrawing(request, drawing.id);
  }
});
