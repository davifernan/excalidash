import { expect, test } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

test("application and Excalidraw notifications share one semantic stack", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: `Notification facade ${Date.now()}` });

  try {
    await openEditor(page, drawing.id, { settleMs: 300 });

    await page.evaluate(async () => {
      const { notify } = await import("/src/notifications/index.tsx");
      const { createExcalidrawToastForwarder } =
        await import("/src/integrations/excalidraw/toastBridge.ts");
      notify("error", "A blocking operation failed", { key: "visual-error" });
      notify("warning", "The board needs attention", { key: "visual-warning" });
      notify("success", "Changes saved", { key: "visual-success" });
      notify("loading", "Uploading document", { key: "visual-loading", detail: "42%" });
      const upstreamToast = {
        message: "Excalidraw action completed",
        closable: true,
        duration: 30_000,
      };
      createExcalidrawToastForwarder()(upstreamToast);

      // Excalidraw renders this same appState signal through its own .Toast
      // outlet. Plant the upstream outlet so this browser assertion proves it
      // cannot become a second visible notification location.
      const nativeOutlet = document.createElement("div");
      nativeOutlet.className = "Toast";
      nativeOutlet.textContent = upstreamToast.message;
      document.querySelector(".excalidraw")?.append(nativeOutlet);
    });

    const host = page.locator("[data-sonner-toaster]");
    await expect(host).toHaveCount(1);
    await expect(host.locator("[data-sonner-toast]")).toHaveCount(5);
    for (const message of [
      "A blocking operation failed",
      "The board needs attention",
      "Changes saved",
      "Uploading document",
      "Excalidraw action completed",
    ]) {
      await expect(host.getByText(message, { exact: true })).toBeVisible();
    }
    await expect(host.getByText("42%", { exact: true })).toBeVisible();
    const nativeOutlet = page.locator(".excalidraw .Toast");
    await expect(nativeOutlet).toHaveCount(1);
    await expect(nativeOutlet).toBeHidden();

    const semantics = await host.evaluate((element) => ({
      position: getComputedStyle(element).position,
      zIndex: getComputedStyle(element).zIndex,
      semanticLayer: getComputedStyle(document.documentElement)
        .getPropertyValue("--excalidash-z-notification")
        .trim(),
      nativeToastDisplays: [...document.querySelectorAll<HTMLElement>(".excalidraw .Toast")].map(
        (toast) => getComputedStyle(toast).display,
      ),
    }));
    expect(semantics.position).toBe("fixed");
    expect(Number(semantics.zIndex)).toBeGreaterThan(0);
    expect(semantics.semanticLayer).not.toBe("");
    expect(semantics.nativeToastDisplays.every((display) => display === "none")).toBe(true);

    await page.screenshot({
      path: "test-results/nil-614-notification-stack.png",
      fullPage: true,
    });
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
