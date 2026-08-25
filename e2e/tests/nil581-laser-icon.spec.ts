import { test } from "@playwright/test";
import { createDrawing } from "./helpers/api";
import { openEditor, toolbarButton } from "./helpers/editor";

for (const theme of ["light", "dark"] as const) {
  test(`NIL-581 laser + sticky toolbar buttons, ${theme} theme`, async ({ page, request }) => {
    const drawing = await createDrawing(request);
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
    await openEditor(page, drawing.id, { settleMs: 500 });

    await page.waitForSelector(".App-toolbar");
    await page.waitForTimeout(300);

    await page.locator(".App-toolbar").screenshot({ path: `/tmp/nil581/toolbar-${theme}.png` });

    const laser = page.locator('.App-toolbar label[title^="Laser pointer"]');
    const sticky = page.locator('.App-toolbar label[data-testid="toolbar-sticky"]');
    await laser.screenshot({ path: `/tmp/nil581/laser-${theme}.png` });
    await sticky.screenshot({ path: `/tmp/nil581/sticky-${theme}.png` });
  });
}
