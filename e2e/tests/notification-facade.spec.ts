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
      // NIL-696: these `import()` calls run INSIDE the browser page (via
      // `page.evaluate`), resolved by the frontend's own Vite dev server as
      // a URL -- not by Node or by `tsc`'s module resolution relative to
      // `e2e/`. There is no repo-relative path that would make `tsc` see
      // these correctly; the absolute `/src/...` form is what the running
      // page actually serves and must stay exactly as written. Held in a
      // variable (rather than inlined as a string literal) so `tsc` cannot
      // statically resolve -- and therefore cannot flag -- the specifier;
      // an inlined literal here needs a `@ts-expect-error` whose required
      // line shifts under reformatting and silently stops suppressing.
      const notificationsModulePath = "/src/notifications/index.tsx";
      const toastBridgeModulePath = "/src/integrations/excalidraw/toastBridge.ts";
      const { notify } = await import(notificationsModulePath);
      const { createExcalidrawToastForwarder } = await import(toastBridgeModulePath);
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
