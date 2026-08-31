import { expect, test, type APIRequestContext } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * The visible half of "agent surfaces follow the agent runtime".
 *
 * The gate is a frontend decision driven by one server answer, so this spec
 * changes the answer rather than the server: intercepting `/system/features`
 * proves the gate itself, independently of how any particular deployment is
 * configured. Both halves come from one run, so the two screenshots differ in
 * exactly one variable.
 */
test.describe("agent surfaces follow the deployment", () => {
  let drawingId = "";
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    drawingId = (await createDrawing(request, { name: `agent-surfaces-${Date.now()}` })).id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => undefined);
  });

  test("shows the agent entries on an agent-enabled instance and none without one", async ({
    page,
  }, testInfo) => {
    // This CI server sets AGENT_FEATURES_ENABLED=true, so the untouched board
    // is the "before" picture.
    await openEditor(page, drawingId, { settleMs: 500 });
    await page.getByTestId("main-menu-trigger").click();
    await expect(page.getByTestId("menu-agent-runtime")).toBeVisible();
    await expect(page.getByTestId("menu-new-orchestrator-thread")).toBeVisible();
    const enabledShot = testInfo.outputPath("agent-surfaces-enabled.png");
    await page.screenshot({ path: enabledShot });
    await testInfo.attach("agent-surfaces-enabled", {
      path: enabledShot,
      contentType: "image/png",
    });

    // Same board, same session, one different answer from the deployment.
    await page.route("**/system/features", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents: false }),
      }),
    );
    await page.reload();
    await openEditor(page, drawingId, { settleMs: 500 });
    await page.getByTestId("main-menu-trigger").click();
    await expect(page.getByTestId("menu-agent-runtime")).toHaveCount(0);
    await expect(page.getByTestId("menu-new-orchestrator-thread")).toHaveCount(0);
    // The menu is not empty -- this hides agent entries, not the menu.
    await expect(page.getByTestId("main-menu-trigger")).toBeVisible();
    const disabledShot = testInfo.outputPath("agent-surfaces-disabled.png");
    await page.screenshot({ path: disabledShot });
    await testInfo.attach("agent-surfaces-disabled", {
      path: disabledShot,
      contentType: "image/png",
    });
  });
});
