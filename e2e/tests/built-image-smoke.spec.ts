import { test, expect, type APIRequestContext } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { armTool, labels, notes, openEditor } from "./helpers/editor";

/**
 * Runs against the real built-and-served image (NIL-649), never against the
 * dev server -- see docker-compose.e2e-smoke.yml and the "E2E Built Image
 * Smoke" job in .github/workflows/test.yml, which are the only callers that
 * point this project at a live server at all (`--project=built-image`).
 *
 * Deliberately one flow, not four specs: this exists to catch the class of
 * bug that only exists between `npm run build`/nginx and `npm run dev`
 * (minification, tree-shaking, `import.meta.env` branches, build-time asset
 * copying, the nginx `/api/` rewrite), not to duplicate the ordinary suite.
 * Board-open, sticky-note-with-a-label, and a written comment were picked
 * because a real incident (NIL-644) shipped a build where writing a comment
 * silently failed while `comments-two-account.spec.ts` stayed green against
 * the dev server -- exactly the gap this job exists to close. The reload at
 * the end is the same "did it actually leave the browser" check
 * sticky-notes.spec.ts's "survives a reload" test already makes for the
 * note; comments get the identical treatment here rather than a second spec.
 */
test.describe("built image smoke", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-built-image-smoke-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("opens a board, writes a sticky note and a comment, and both survive a reload", async ({
    page,
  }) => {
    await openEditor(page, drawingId);

    // --- Sticky note -----------------------------------------------------
    await armTool(page);
    await page
      .locator("canvas")
      .last()
      .click({ position: { x: 400, y: 300 } });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible({ timeout: 5000 });
    await page.keyboard.type("Built image smoke note");
    await page.keyboard.press("Escape");
    // Autosave debounces the scene write; the reload below has to land after
    // it actually reaches the backend, not just after the local edit
    // settles (sticky-notes.spec.ts's "survives a reload" test waits the
    // same 1500ms for the same reason).
    await page.waitForTimeout(1500);

    // --- Comment -----------------------------------------------------------
    await page.getByTestId("main-menu-trigger").click();
    // Not `{ exact: true }`: the label grows an unresolved-count suffix
    // ("Comments (1)") once a comment exists, exactly like it does after
    // this test's own comment lands and the panel is reopened below.
    await page
      .locator('[data-testid="dropdown-menu"]')
      .getByText(/^Comments/)
      .click();
    await expect(page.getByTestId("comment-panel")).toBeVisible();

    await page.getByTestId("comment-begin-placing").click();
    await page.locator(".excalidraw__canvas.interactive").click({ position: { x: 500, y: 500 } });
    await expect(page.getByText("Anchored to point")).toBeVisible();

    const commentInput = page.getByTestId("new-comment-input");
    await commentInput.click();
    await commentInput.type("Built image smoke comment");
    await page.getByTestId("new-comment-submit").click();

    await expect(page.getByTestId("comment-thread").first()).toContainText(
      "Built image smoke comment",
    );

    // --- Reload: both must have actually left the browser -----------------
    await openEditor(page, drawingId);
    await page.waitForTimeout(400);

    const placedNotes = await notes(page);
    expect(placedNotes).toHaveLength(1);
    const [label] = await labels(page);
    expect(label.originalText).toContain("Built image smoke note");

    await page.getByTestId("main-menu-trigger").click();
    await page
      .locator('[data-testid="dropdown-menu"]')
      .getByText(/^Comments/)
      .click();
    await expect(page.getByTestId("comment-thread").first()).toContainText(
      "Built image smoke comment",
      { timeout: 10000 },
    );
  });
});
