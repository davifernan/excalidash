import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { installLaserPointerDomBridge } from "./domBridge";

describe("the Excalidraw laser pointer DOM bridge", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the outer control, labels its shortcut, and hides late menu duplicates", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <label title="Laser pointer">
        <input data-testid="toolbar-LaserPointer" aria-label="Laser pointer" />
      </label>
    `;
    document.body.append(root);

    const uninstall = installLaserPointerDomBridge(root);
    const outer = root.querySelector<HTMLInputElement>('[data-testid="toolbar-LaserPointer"]');
    expect(outer?.getAttribute("aria-label")).toBe("Laser pointer — K");
    expect(outer?.getAttribute("aria-keyshortcuts")).toBe("K");
    expect(outer?.closest("label")?.title).toBe("Laser pointer — K");

    const menuDuplicate = document.createElement("button");
    menuDuplicate.dataset.testid = "toolbar-laser";
    root.append(menuDuplicate);
    await waitFor(() => expect(menuDuplicate.hidden).toBe(true));

    expect(outer?.hidden).toBe(false);
    uninstall();
  });
});
