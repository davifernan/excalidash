import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";

const openEditor = async (page: Page, drawingId: string) => {
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector(".excalidraw", { timeout: 30_000 });
  await expect(page.getByTestId("editor-top-left")).toBeVisible();
};

test("an HTTP-confirmed rename updates every open editor live", async ({ browser, request }) => {
  const originalName = `Live name ${Date.now()}`;
  const nextName = `${originalName} renamed`;
  const drawing = await createDrawing(request, { name: originalName });
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();

  try {
    await Promise.all([openEditor(firstPage, drawing.id), openEditor(secondPage, drawing.id)]);

    await firstPage.getByTitle(`${originalName} — double-click to rename`).dblclick();
    const nameInput = firstPage.getByRole("textbox", { name: "Drawing name" });
    await nameInput.fill(nextName);
    await nameInput.press("Enter");

    await expect(secondPage.getByRole("heading", { name: nextName })).toBeVisible();
    await expect(secondPage).toHaveTitle(`${nextName} - ExcaliDash`);
    await expect.poll(async () => (await getDrawing(request, drawing.id)).name).toBe(nextName);
  } finally {
    await firstContext.close();
    await secondContext.close();
    await deleteDrawing(request, drawing.id);
  }
});
