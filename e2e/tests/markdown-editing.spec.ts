import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { activateDocumentWidget, dropMarkdown, openEditor } from "./helpers/editor";

test("Markdown edit is durable and a second browser is explicitly locked out", async ({
  browser,
  request,
}) => {
  const drawing = await createDrawing(request, { name: `Markdown editing ${Date.now()}` });
  const writerContext = await browser.newContext({ recordVideo: { dir: "test-results" } });
  const readerContext = await browser.newContext({ recordVideo: { dir: "test-results" } });
  const writer = await writerContext.newPage();
  const reader = await readerContext.newPage();

  try {
    await openEditor(writer, drawing.id, { settleMs: 500 });
    await dropMarkdown(writer, "# Original notes\n\nBefore editing.\n", "editable-notes.md");
    await expect(writer.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await activateDocumentWidget(writer);
    await expect(writer.getByRole("button", { name: "Edit Markdown" })).toBeVisible();
    // The server materialises the widget binding during the first scene save;
    // lock acquisition deliberately refuses a merely local element.
    await writer.waitForTimeout(2_000);

    await openEditor(reader, drawing.id, { settleMs: 500 });
    await expect(reader.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await activateDocumentWidget(reader);
    await writer.screenshot({ path: "test-results/nil567-before-edit.png" });

    await writer.getByRole("button", { name: "Edit Markdown" }).click();
    const source = writer.getByRole("textbox", { name: "Markdown source" });
    await expect(source).toHaveValue("# Original notes\n\nBefore editing.\n");
    await source.fill("# Persisted notes\n\nThis survived a reload.\n");

    await expect(reader.getByText(/^Editing:/)).toBeVisible({ timeout: 10_000 });
    await expect(reader.getByRole("button", { name: "Edit Markdown" })).toBeDisabled();
    const lockToolbar = await reader
      .getByRole("toolbar", { name: "Document controls" })
      .boundingBox();
    expect(lockToolbar).not.toBeNull();
    console.log(`NIL-567 second-browser lock toolbar: ${JSON.stringify(lockToolbar)}`);
    await reader.screenshot({ path: "test-results/nil567-second-browser-lock.png" });

    await writer.getByRole("button", { name: "Save Markdown" }).click();
    await expect(writer.getByRole("heading", { name: "Persisted notes" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(reader.getByRole("heading", { name: "Persisted notes" })).toBeVisible({
      timeout: 30_000,
    });

    await writer.reload();
    await writer.waitForSelector("canvas");
    await writer.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
    await expect(writer.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await expect(writer.getByRole("heading", { name: "Persisted notes" })).toBeVisible();
    await activateDocumentWidget(writer);
    await expect(writer.getByRole("button", { name: "Edit Markdown" })).toBeEnabled();
    await writer.screenshot({ path: "test-results/nil567-persisted-after-reload.png" });
  } finally {
    await writerContext.close();
    await readerContext.close();
    await deleteDrawing(request, drawing.id).catch(() => {});
  }
});
