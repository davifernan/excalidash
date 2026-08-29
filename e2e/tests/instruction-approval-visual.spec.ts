import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import Database from "../../backend/node_modules/better-sqlite3";
import { createDrawing, deleteDrawing, getDrawing, updateDrawing } from "./helpers/api";
import { armTool, openEditor } from "./helpers/editor";

const placeStickyInFrame = async (page: Page) => {
  const canvas = page.locator("canvas.excalidraw__canvas.interactive");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Interactive canvas is not available.");
  await canvas.click({ position: { x: 900, y: 600 } });
  await page.keyboard.press("f");
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 900, canvasBox.y + 560, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const frame = await page.evaluate(() =>
    (window as any).__EXCALIDASH_TEST__
      .getSceneElements()
      .find((element: any) => element.type === "frame"),
  );
  await armTool(page);
  await page
    .locator("canvas")
    .last()
    .click({
      position: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
    });
  await page.locator("textarea.excalidraw-wysiwyg").fill("Review this instruction");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const elements = (window as any).__EXCALIDASH_TEST__.getSceneElements();
    const frame = elements.find((element: any) => element.type === "frame");
    const label = elements.find(
      (element: any) => element.type === "text" && element.frameId === frame?.id,
    );
    return { frameId: frame?.id as string, labelId: label?.id as string };
  });
};

const seedContext = (drawingId: string, frameElementId: string) => {
  // NIL-675 owns the human Context-creation UI. This test seeds only the
  // already-authoritative server row so NIL-676 can exercise its own UI seam.
  // CI gives each suite its own DATABASE_URL. Locally, Playwright's webServer
  // uses backend/prisma/dev.db, so retain that as the explicit fallback.
  const databaseUrl =
    process.env.DATABASE_URL ?? `file:${path.resolve(process.cwd(), "../backend/prisma/dev.db")}`;
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("Instruction approval visual test requires a SQLite DATABASE_URL.");
  }
  const database = new Database(databaseUrl.slice("file:".length));
  try {
    database
      .prepare(
        'INSERT INTO "AgentContext" (id,drawingId,frameElementId,pinned,updatedAt) VALUES (?,?,?,?,?)',
      )
      .run("e2e-instruction-context", drawingId, frameElementId, 0, new Date().toISOString());
  } finally {
    database.close();
  }
};

test("instruction approval keeps preview, re-approval, and dispatch visibly separate", async ({
  page,
  request,
}, testInfo) => {
  const drawing = await createDrawing(request, { name: `Instruction approval ${Date.now()}` });
  try {
    await openEditor(page, drawing.id, { settleMs: 500 });
    const { frameId, labelId } = await placeStickyInFrame(page);
    expect(frameId).toBeTruthy();
    expect(labelId).toBeTruthy();
    // The UI save is debounced. Persist the scene through the normal drawing
    // API before declaring its frame a server Context, otherwise the Context
    // can briefly reference a frame the stored drawing has not received yet.
    const currentDrawing = await getDrawing(request, drawing.id);
    await updateDrawing(request, drawing.id, {
      elements: await page.evaluate(() => (window as any).__EXCALIDASH_TEST__.getSceneElements()),
      version: currentDrawing.version,
    });
    seedContext(drawing.id, frameId);

    await page.reload();
    await openEditor(page, drawing.id, { settleMs: 1_000 });
    await page.evaluate((elementId) => {
      (window as any).__EXCALIDASH_TEST__.updateScene({
        appState: { selectedElementIds: { [elementId]: true } },
      });
    }, labelId);

    const toolbar = page.getByRole("toolbar", { name: "Agent-Anweisung" });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Als Agent-Anweisung freigeben" }).click();
    await expect(toolbar.getByText("Geprüfte Fassung", { exact: false })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Diese Fassung freigeben" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Agent-Dispatch öffnen" })).toHaveCount(0);
    const previewScreenshot = testInfo.outputPath("instruction-approval-preview.png");
    await page.screenshot({ path: previewScreenshot });
    await testInfo.attach("instruction-approval-preview", {
      path: previewScreenshot,
      contentType: "image/png",
    });

    await toolbar.getByRole("button", { name: "Diese Fassung freigeben" }).click();
    await expect(toolbar.getByText("Anweisung · freigegeben")).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Agent-Dispatch öffnen" })).toBeVisible();
    const approvedScreenshot = testInfo.outputPath("instruction-approval-approved.png");
    await page.screenshot({ path: approvedScreenshot });
    await testInfo.attach("instruction-approval-approved", {
      path: approvedScreenshot,
      contentType: "image/png",
    });
  } finally {
    await deleteDrawing(request, drawing.id).catch(() => undefined);
  }
});
