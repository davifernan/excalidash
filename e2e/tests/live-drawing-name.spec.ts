import { expect, test } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

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

    // The board name lives in the hamburger now, not a floating island
    // (NIL-376) -- open it before the double-click can reach the name.
    await firstPage.getByTestId("main-menu-trigger").click();
    await firstPage.getByTitle(`${originalName} — double-click to rename`).dblclick();
    const nameInput = firstPage.getByRole("textbox", { name: "Drawing name" });
    await nameInput.fill(nextName);
    await nameInput.press("Enter");

    await secondPage.getByTestId("main-menu-trigger").click();
    await expect(secondPage.getByTestId("menu-board-name")).toContainText(nextName);
    await expect(secondPage).toHaveTitle(`${nextName} - ExcaliDash`);
    await expect.poll(async () => (await getDrawing(request, drawing.id)).name).toBe(nextName);
  } finally {
    await firstContext.close();
    await secondContext.close();
    await deleteDrawing(request, drawing.id);
  }
});
