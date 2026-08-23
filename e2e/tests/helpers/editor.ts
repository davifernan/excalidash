import type { Page } from "@playwright/test";

/**
 * The browser-side counterpart to helpers/api.ts.
 *
 * `window.__EXCALIDASH_TEST__` (frontend/src/pages/Editor.tsx) is the one
 * harness a spec is allowed to reach the running editor through -- it goes via
 * the same adapter the product uses, rather than around it. This file is the
 * shared layer above that raw global: `openEditor`, `armTool`, `scene` and
 * friends were each written out three to eight times across specs before this
 * existed. Add to it only what a second spec actually needs, not what a
 * future one might.
 */

const hasHarness = () => !!(window as unknown as Record<string, unknown>).__EXCALIDASH_TEST__;

/** Open a drawing and wait until the harness is live, not just the canvas. */
export const openEditor = async (
  page: Page,
  drawingId: string,
  options?: { settleMs?: number },
): Promise<Page> => {
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector("canvas");
  await page.waitForFunction(hasHarness);
  if (options?.settleMs) await page.waitForTimeout(options.settleMs);
  return page;
};

/**
 * The scene, projected to the fields specs actually assert on. Extend this
 * projection rather than reading `getSceneElements()` ad hoc in a spec --
 * one place to keep in sync with the harness's element shape.
 */
export const scene = (page: Page) =>
  page.evaluate(() => {
    const api = (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__;
    return api.getSceneElements().map((element: any) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      backgroundColor: element.backgroundColor,
      containerId: element.containerId,
      fontSize: element.fontSize,
      text: element.text,
      sticky: element.customData?.excalidash?.sticky ?? null,
      schemaVersion: element.customData?.excalidash?.schemaVersion ?? null,
    }));
  });

export const notes = async (page: Page) => (await scene(page)).filter((e: any) => e.sticky);
export const labels = async (page: Page) => (await scene(page)).filter((e: any) => e.containerId);

/** A button registered through `ui.toolbarSlot()`, by its own tool name. */
export const toolbarButton = (page: Page, name: string) =>
  page.getByTestId(`toolbar-${name}`);

/** Arm the sticky-note tool and wait for the editor to confirm it, not just the click. */
export const armTool = async (page: Page) => {
  await toolbarButton(page, "sticky").click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__.getAppState()
        .activeTool?.customType === "sticky",
  );
};
