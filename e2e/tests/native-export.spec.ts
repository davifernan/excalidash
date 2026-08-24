import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * NIL-340 -- the "Export" half of M1's Pflichtpfad "Widgets/Read-only/Export".
 *
 * "Export drawing" (chromeSlots.tsx's own `export` MainMenu entry,
 * `handleExportClick` -> `exportFromEditor`, utils/exportUtils.ts) downloads
 * the current scene as a `.excalidraw` file via a Blob + synthetic anchor
 * click. Nothing in this suite had ever driven it before this package:
 * export-import.spec.ts covers the app's own `.excalidash` backup format at
 * the REST layer and the *import* side of `.excalidraw` files through the
 * dashboard, never this button. Download handling is exactly the kind of
 * thing an engine decides rather than this application, so it belongs on
 * every engine from the day it gets covered at all -- see this spec's entry
 * in playwright.config.ts's CROSS_ENGINE_SPECS.
 *
 * The other half of this Pflichtpfad, view-only share-link rendering, is a
 * named gap -- see playwright.config.ts's comment on this file's entry and
 * this package's Multica HANDOFF for why and what closing it would take.
 */

const openMenu = async (page: import("@playwright/test").Page) => {
  await page.getByTestId("main-menu-trigger").click();
};

const rect = {
  id: "nil340_export_probe",
  type: "rectangle",
  x: 120,
  y: 140,
  width: 160,
  height: 120,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "#ffec99",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 340,
  version: 1,
  versionNonce: 340,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
};

test("Export drawing downloads a .excalidraw file carrying the current scene", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, {
    name: `NIL340_NativeExport_${Date.now()}`,
    elements: [],
  });

  try {
    await openEditor(page, drawing.id);
    await page.evaluate((element) => {
      (window as any).__EXCALIDASH_TEST__.updateScene({ elements: [element] });
    }, rect);
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as any).__EXCALIDASH_TEST__.getSceneElements().length,
        ),
      )
      .toBe(1);

    await openMenu(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByText("Export drawing").click(),
    ]);

    expect(download.suggestedFilename()).toBe(`${drawing.name}.excalidraw`);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const contents = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

    expect(contents.type).toBe("excalidraw");
    expect(Array.isArray(contents.elements)).toBe(true);
    expect(contents.elements).toHaveLength(1);
    expect(contents.elements[0].id).toBe(rect.id);
    expect(contents.elements[0].type).toBe("rectangle");
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
