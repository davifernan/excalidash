import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import {
  activateDocumentWidget,
  dropMarkdown,
  openEditor,
  waitForDocumentWidgetLoaded,
} from "./helpers/editor";

test("Markdown edit is durable and a second browser is explicitly locked out", async ({
  browser,
  request,
}) => {
  const drawing = await createDrawing(request, { name: `Markdown editing ${Date.now()}` });
  const writerContext = await browser.newContext({ recordVideo: { dir: "test-results" } });
  const readerContext = await browser.newContext({ recordVideo: { dir: "test-results" } });
  const writer = await writerContext.newPage();
  const reader = await readerContext.newPage();
  const writerDraftFrames: string[] = [];
  writer.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && payload.includes('"document-edit-draft-command"')) {
        writerDraftFrames.push(payload);
      }
    });
  });

  try {
    await openEditor(writer, drawing.id, { settleMs: 500 });
    await dropMarkdown(writer, "# Original notes\n\nBefore editing.\n", "editable-notes.md");
    await expect(writer.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await waitForDocumentWidgetLoaded(writer);
    await activateDocumentWidget(writer);
    await expect(writer.getByRole("button", { name: "Edit Markdown" })).toBeVisible();
    // The server materialises the widget binding during the first scene save;
    // lock acquisition deliberately refuses a merely local element.
    await writer.waitForTimeout(2_000);

    await openEditor(reader, drawing.id, { settleMs: 500 });
    await expect(reader.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await waitForDocumentWidgetLoaded(reader);
    await activateDocumentWidget(reader);
    await writer.screenshot({ path: "test-results/nil567-before-edit.png" });

    await writer.getByRole("button", { name: "Edit Markdown" }).click();
    const source = writer.getByRole("textbox", { name: "Markdown source" });
    await expect(source).toHaveValue("# Original notes\n\nBefore editing.\n");

    await expect(reader.getByText(/^Editing:/)).toBeVisible({ timeout: 10_000 });
    await expect(reader.getByRole("button", { name: "Edit Markdown" })).toBeDisabled();
    const lockToolbar = await reader
      .getByRole("toolbar", { name: "Document controls" })
      .boundingBox();
    expect(lockToolbar).not.toBeNull();
    console.log(`NIL-567 second-browser lock toolbar: ${JSON.stringify(lockToolbar)}`);
    await reader.screenshot({ path: "test-results/nil616-before-live-edit.png" });

    const draftFramesBeforeTyping = writerDraftFrames.length;
    const typingStartedAt = Date.now();
    await source.fill("# Live notes\n\n");
    await source.pressSequentially(
      "This unsaved draft is already visible to everyone watching the board.",
      { delay: 10 },
    );
    await expect(reader.getByRole("heading", { name: "Live notes" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(reader.getByText(/already visible to everyone/)).toBeVisible();
    await reader.screenshot({ path: "test-results/nil616-reader-live-draft.png" });
    const typingDurationMs = Date.now() - typingStartedAt;
    const draftFramesWhileTyping = writerDraftFrames.length - draftFramesBeforeTyping;
    expect(draftFramesWhileTyping).toBeGreaterThan(1);
    expect(draftFramesWhileTyping).toBeLessThanOrEqual(Math.ceil(typingDurationMs / 150) + 2);
    console.log(
      `NIL-616 live draft frequency: ${draftFramesWhileTyping} packets in ${typingDurationMs}ms ` +
        `(shared 150ms publisher; ceiling 7 packets/s)`,
    );

    await source.evaluate((editor) => {
      editor.focus();
      const start = editor.value.indexOf("Live");
      editor.setSelectionRange(start, start + 4);
    });
    const formattingToolbar = writer.getByRole("toolbar", { name: "Markdown formatting" });
    await expect(formattingToolbar.getByRole("button")).toHaveCount(6);
    const formattingBounds = await formattingToolbar.boundingBox();
    expect(formattingBounds).not.toBeNull();
    await formattingToolbar.getByRole("button", { name: "Bold" }).click();
    const focusMeasurement = await source.evaluate((editor) => ({
      retained: document.activeElement === editor,
      selection: [editor.selectionStart, editor.selectionEnd],
    }));
    expect(focusMeasurement).toEqual({ retained: true, selection: [4, 8] });
    await expect(reader.getByRole("heading", { name: "Live notes" })).toBeVisible();
    console.log(
      `NIL-616 formatting toolbar: ${JSON.stringify(formattingBounds)}, ` +
        `buttons=6, focusRetained=${focusMeasurement.retained}`,
    );
    await writer.screenshot({ path: "test-results/nil616-toolbar-live-edit.png" });

    await writer.getByRole("button", { name: "Cancel Markdown editing" }).click();
    await expect(reader.getByRole("heading", { name: "Original notes" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(reader.getByRole("heading", { name: "Live notes" })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Edit Markdown" })).toBeEnabled();
    await reader.screenshot({ path: "test-results/nil616-cancel-rollback.png" });

    await writer.getByRole("button", { name: "Edit Markdown" }).click();
    await source.fill("# Persisted notes\n\nThis survived a reload.\n");
    await expect(reader.getByRole("heading", { name: "Persisted notes" })).toBeVisible({
      timeout: 10_000,
    });

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
    await waitForDocumentWidgetLoaded(writer);
    // NIL-664: this follows a full page navigation (reload) plus a fresh
    // asset/content fetch and off-thread pagination -- heavier than the
    // socket-pushed re-renders at lines 116/119 above, which already get an
    // explicit 30_000ms here instead of the file's 10_000ms default
    // (playwright.config.ts's `expect.timeout`). This assertion was the one
    // case of that same "wait for content to survive a reload/save" pattern
    // left on the short default, and is exactly where CI measured it fail.
    await expect(writer.getByRole("heading", { name: "Persisted notes" })).toBeVisible({
      timeout: 30_000,
    });
    await activateDocumentWidget(writer);
    await expect(writer.getByRole("button", { name: "Edit Markdown" })).toBeEnabled();
    await writer.screenshot({ path: "test-results/nil567-persisted-after-reload.png" });
  } finally {
    await writerContext.close();
    await readerContext.close();
    await deleteDrawing(request, drawing.id).catch(() => {});
  }
});
