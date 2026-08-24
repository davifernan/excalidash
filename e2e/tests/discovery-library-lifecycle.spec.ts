import { test, expect } from "@playwright/test";
import { API_URL, createDrawing, deleteDrawing, getCsrfHeaders } from "./helpers/api";

/**
 * NIL-366: Find -> Reuse -> Archive -> Restore, in a real browser, through
 * the surfaces NIL-326 (M5) added -- the merged /search page (name AND
 * content matches, with a snippet), the Team Library manager, and the
 * Archive lifecycle.
 *
 * Runs against the shared no-auth "bootstrap identity" backend the rest of
 * this suite's `npm test` already spins up (one account, no permission
 * boundary to cross) -- the permission-matrix negative paths (a stranger
 * finds nothing, no count leak) are covered separately: at the query level
 * with a red-probed real-database test in
 * `backend/src/routes/dashboard/searchRoutes.test.ts` (proven to fail if the
 * visibility `where` clause is ever dropped), and in the browser with real,
 * distinct accounts in `discovery-permission-matrix.spec.ts` in this
 * directory (isolated two-account run, same pattern as
 * `comments-two-account.spec.ts` -- see that spec's own header for why this
 * cannot share the default bootstrap backend).
 */

test.describe("NIL-366: Find -> Reuse -> Archive -> Restore", () => {
  let createdDrawingIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdDrawingIds) {
      try {
        await deleteDrawing(request, id);
      } catch {
        // best-effort cleanup
      }
    }
    createdDrawingIds = [];
  });

  test("finds a board by its visible text content, not just its name, with a snippet", async ({
    page,
    request,
  }) => {
    const runId = Date.now().toString(36);
    const contentTerm = `quarterlyRoadmapTerm${runId}`;
    const drawing = await createDrawing(request, {
      name: `NIL-366 content search ${runId}`,
      elements: [
        {
          id: "el-1",
          type: "text",
          x: 0,
          y: 0,
          width: 200,
          height: 25,
          angle: 0,
          strokeColor: "#000000",
          backgroundColor: "transparent",
          fillStyle: "hachure",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          link: null,
          locked: false,
          text: `Ship the ${contentTerm} plan`,
          fontSize: 20,
          fontFamily: 1,
          textAlign: "left",
          verticalAlign: "top",
          containerId: null,
          originalText: `Ship the ${contentTerm} plan`,
          lineHeight: 1.25,
        },
      ],
    });
    createdDrawingIds.push(drawing.id);

    await page.goto("/search");
    await page.waitForLoadState("networkidle");

    await page.getByPlaceholder("Search boards by name or content").fill(contentTerm);
    await expect(page.getByText(drawing.name)).toBeVisible();
    await expect(page.getByText("content match")).toBeVisible();
    await expect(page.getByText(new RegExp(contentTerm))).toBeVisible();
  });

  test("archives a board from Search, it leaves the default view, appears in Archive, and Restore brings it back", async ({
    page,
    request,
  }) => {
    const runId = Date.now().toString(36);
    const name = `NIL-366 lifecycle ${runId}`;
    const drawing = await createDrawing(request, { name });
    createdDrawingIds.push(drawing.id);

    await page.goto("/search");
    await page.waitForLoadState("networkidle");

    // Find.
    await page.getByPlaceholder("Search boards by name or content").fill(name);
    await expect(page.getByText(name)).toBeVisible();

    // Archive.
    await page.getByRole("button", { name: `Archive ${name}` }).click();

    // Gone from the default search the moment it's archived.
    await expect(page.getByText(name)).not.toBeVisible();
    await page.getByPlaceholder("Search boards by name or content").fill("");
    await page.getByPlaceholder("Search boards by name or content").fill(name);
    await expect(page.getByText(name)).not.toBeVisible();

    // Present in the Archive view, with Restore instead of Archive.
    await page.getByRole("tab", { name: "Archive" }).click();
    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByRole("button", { name: `Restore ${name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Archive ${name}` })).not.toBeVisible();

    // Restore.
    await page.getByRole("button", { name: `Restore ${name}` }).click();
    await expect(page.getByText(name)).not.toBeVisible(); // left the Archive view

    // Back in the default search.
    await page.getByRole("tab", { name: "Search" }).click();
    await page.getByPlaceholder("Search boards by name or content").fill(name);
    await expect(page.getByText(name)).toBeVisible();
  });

  test("the Team Library manager shows an item and lets its owner publish it to the team", async ({
    page,
    request,
  }) => {
    const runId = Date.now().toString(36);
    const itemName = `NIL-366 library item ${runId}`;
    const headers = await getCsrfHeaders(request);

    // Seeds one personal-visibility item the way the Excalidraw library
    // panel's own sync would (PUT /library, the whole-array contract
    // library.ts's diff logic expects) -- not a shortcut around it.
    const putResponse = await request.put(`${API_URL}/library`, {
      headers: { ...headers, "Content-Type": "application/json" },
      data: {
        items: [
          {
            id: `e2e-item-${runId}`,
            status: "published",
            elements: [{ type: "rectangle" }],
            name: itemName,
          },
        ],
      },
    });
    expect(putResponse.ok()).toBe(true);

    await page.goto("/library");
    await page.waitForLoadState("networkidle");

    const itemRow = page.getByRole("listitem").filter({ hasText: itemName });
    await expect(itemRow).toBeVisible();
    await expect(itemRow.getByText("Personal")).toBeVisible();

    await page.getByRole("button", { name: "Publish to team" }).click();
    await expect(page.getByRole("button", { name: "Make personal" })).toBeVisible();

    // Cleanup: leave the library the way this test found it.
    await page.getByRole("button", { name: `Delete ${itemName}` }).click();
    await expect(page.getByText(itemName)).not.toBeVisible();
  });
});
