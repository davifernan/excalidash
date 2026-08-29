import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

const openAgents = async (page: Page) => {
  await page.getByTestId("main-menu-trigger").click();
  await page.getByTestId("menu-agent-runtime").click();
};

test.describe("board Agent Runtime panel", () => {
  let drawingId = "";
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    drawingId = (await createDrawing(request, { name: `agent-runtime-${Date.now()}` })).id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => undefined);
  });

  test("keeps the canvas usable when no runtime is configured", async ({ page }, testInfo) => {
    await openEditor(page, drawingId);
    await openAgents(page);

    await expect(page.getByTestId("agent-runtime-panel")).toContainText("Runtime not connected");
    await expect(page.getByTestId("agent-runtime-panel")).toContainText(
      "The board remains available",
    );
    await expect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("runtime-not-connected.png") });
  });

  test("starts, observes and prompts through the board panel", async ({ page }, testInfo) => {
    await page.route(`**/api/drawings/${drawingId}/agent/runtime`, (route) =>
      route.fulfill({
        json: {
          connections: [
            {
              id: "runtime",
              label: "Herdr",
              audience: { kind: "installation" },
              profiles: [{ id: "review", label: "Review" }],
              health: { connected: true, status: "connected" },
            },
          ],
        },
      }),
    );
    await page.route(`**/api/drawings/${drawingId}/agent/run`, (route) =>
      route.fulfill({
        status: 201,
        json: {
          run: {
            id: "run-1",
            displayName: "Board agent",
            status: "working",
            capabilities: ["agent:read", "agent:run", "agent:prompt"],
          },
          runCapability: "opaque-browser-fixture",
          expiresAt: "2026-08-29T20:00:00.000Z",
        },
      }),
    );
    await page.route(`**/api/drawings/${drawingId}/agent/events`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"id":"run-1","displayName":"Board agent","status":"working"}\n\n',
      }),
    );
    await page.route(`**/api/drawings/${drawingId}/agent/prompt`, (route) =>
      route.fulfill({ json: { id: "run-1", status: "idle" } }),
    );

    await openEditor(page, drawingId);
    await openAgents(page);
    const panel = page.getByTestId("agent-runtime-panel");
    await expect(panel.getByRole("combobox").nth(0)).toHaveValue("runtime");
    await expect(panel.getByRole("combobox").nth(1)).toHaveValue("review");
    await panel.getByRole("button", { name: "Start agent" }).click();
    await expect(panel).toContainText("Board agent");
    await expect(panel).toContainText("working");

    await panel.getByLabel("Prompt").fill("Continue the review");
    await panel.getByRole("button", { name: "Send prompt" }).click();
    await expect(panel).toContainText("idle");
    await expect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("runtime-run-idle.png") });
  });
});
