import { expect, test } from "@playwright/test";
import { API_URL, createDrawing, deleteDrawing, getCsrfHeaders } from "./helpers/api";

/**
 * The visible half of "changing the terms does not change the address".
 *
 * The share dialog looks identical before and after, so a screenshot of it
 * would prove nothing. What is worth seeing is the other side: a URL that was
 * handed out earlier, opened after the permission changed, still showing the
 * board. That is the promise, and it is what the picture shows.
 *
 * The link is opened in a context with no session at all -- an anonymous
 * visitor, the way a real recipient arrives -- so a passing run cannot be
 * explained by the opener being signed in.
 */
test.describe("a share link survives a permission change", () => {
  test("the URL handed out before the change still opens the board", async ({
    browser,
    request,
  }, testInfo) => {
    const drawing = await createDrawing(request, { name: `share-stable-${Date.now()}` });

    try {
      const headers = await getCsrfHeaders(request);
      const created = await request.post(`${API_URL}/drawings/${drawing.id}/link-shares`, {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { permission: "view" },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      const { token, share } = await created.json();
      expect(token).toBeTruthy();

      // This is the URL a person would already have sent to somebody.
      const sharedUrl = `/shared/${drawing.id}#shareToken=${encodeURIComponent(token)}`;

      const patchHeaders = await getCsrfHeaders(request);
      const changed = await request.patch(
        `${API_URL}/drawings/${drawing.id}/link-shares/${share.id}`,
        {
          headers: { ...patchHeaders, "Content-Type": "application/json" },
          data: { permission: "edit" },
        },
      );
      expect(changed.ok(), await changed.text()).toBeTruthy();
      const changedBody = await changed.json();
      expect(changedBody.share.permission).toBe("edit");
      // Nothing to re-send: this endpoint cannot mint a secret.
      expect(changedBody.token).toBeUndefined();

      const visitorContext = await browser.newContext();
      try {
        const visitor = await visitorContext.newPage();
        await visitor.goto(sharedUrl);
        await expect(visitor.locator("canvas.excalidraw__canvas").first()).toBeVisible({
          timeout: 30_000,
        });

        const shot = testInfo.outputPath("share-link-still-opens-after-change.png");
        await visitor.screenshot({ path: shot });
        await testInfo.attach("share-link-still-opens-after-change", {
          path: shot,
          contentType: "image/png",
        });
      } finally {
        await visitorContext.close();
      }
    } finally {
      await deleteDrawing(request, drawing.id).catch(() => undefined);
    }
  });
});
