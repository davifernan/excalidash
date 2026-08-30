import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";
import { openEditor, scene } from "./helpers/editor";

const openMenu = async (page: Page) => {
  await page.getByTestId("main-menu-trigger").click();
};

test.describe("Orchestrator Thread Board Card (NIL-678)", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `NIL-678 thread ${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("persists the anchor, opens one panel, and docks when the anchor becomes unreadable", async ({
    page,
  }, testInfo) => {
    await openEditor(page, drawingId);
    const invitation = page.getByTestId("orchestrator-thread-invitation");
    await expect(invitation).toBeVisible();
    await expect(invitation).toContainText("Where should we coordinate?");
    await page.screenshot({ path: testInfo.outputPath("empty-board-invitation.png") });
    await page.getByRole("button", { name: "Place thread here" }).click();
    await expect(invitation).toHaveCount(0);

    const panel = page.getByTestId("orchestrator-thread-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-mode", "anchored");
    await expect(panel).toContainText("No orchestrator events yet");
    await expect(page.getByTestId("orchestrator-thread-panel")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("anchored-thread-panel.png") });

    // A zoom that makes the Board Card unreadably small changes the OPEN
    // state to docked. It does not turn the feature into an always-present
    // sidebar: the panel names the unreachable anchor and offers a jump.
    const zoomOut = page.getByRole("button", { name: "Zoom out" });
    for (let step = 0; step < 6; step += 1) await zoomOut.click();
    await expect(panel).toHaveAttribute("data-mode", "docked");
    await expect(panel.getByText(/Anchor outside the readable view/)).toBeVisible();

    await page.getByRole("button", { name: "Reset zoom" }).click();
    await expect(panel).toHaveAttribute("data-mode", "anchored");

    // Wait for ordinary board persistence, then prove a fresh editor mount
    // rediscovers the shared Board Card rather than reconstructing local UI.
    await expect
      .poll(async () => {
        const drawing = await getDrawing(api, drawingId);
        return (drawing.elements ?? []).some(
          (element) => element.customData?.excalidash?.orchestratorThread?.threadId,
        );
      })
      .toBe(true);

    await page.reload();
    await page.waitForSelector("canvas");
    await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
    const card = page.getByTestId("orchestrator-thread-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await expect(panel).toHaveCount(0);

    // The visual overlay must not turn the persisted Excalidraw Board Card
    // into an immovable DOM widget. Dragging through the overlay moves the
    // actual shared element; only its small Open control captures input.
    const beforeDrag = await card.boundingBox();
    if (!beforeDrag) throw new Error("thread Board Card has no browser bounds");
    await page.mouse.move(
      beforeDrag.x + beforeDrag.width / 2,
      beforeDrag.y + beforeDrag.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      beforeDrag.x + beforeDrag.width / 2 + 100,
      beforeDrag.y + beforeDrag.height / 2 + 60,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await card.boundingBox())?.x ?? beforeDrag.x)
      .toBeGreaterThan(beforeDrag.x + 60);

    await page.getByRole("button", { name: /Open Orchestrator/ }).click();
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute("data-mode", "anchored");

    // Creating another shared anchor replaces the local open identity; there
    // is never one full panel per anchor.
    await openMenu(page);
    await page.getByTestId("menu-new-orchestrator-thread").click();
    await expect(page.getByTestId("orchestrator-thread-panel")).toHaveCount(1);
  });

  test("keeps ordinary canvas drawing available through the empty-board invitation", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    const invitation = page.getByTestId("orchestrator-thread-invitation");
    await expect(invitation).toBeVisible();

    // The invitation is visual guidance, not a modal surface. A normal canvas
    // gesture that starts over its body must still reach Excalidraw; only the
    // explicit Place-thread button is interactive DOM chrome.
    await page.locator("canvas.excalidraw__canvas.interactive").click({
      position: { x: 1100, y: 600 },
    });
    await page.keyboard.press("r");
    await page.mouse.move(400, 300);
    await page.mouse.down();
    await page.mouse.move(600, 380, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await scene(page)).filter((element) => element.type === "rectangle").length)
      .toBe(1);
    await expect(invitation).toHaveCount(0);
  });
});
