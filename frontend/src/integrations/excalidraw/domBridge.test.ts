import { afterEach, describe, expect, it, vi } from "vitest";

import { resetDiagnostics, onDiagnostic } from "./compatibility/diagnostics";
import {
  checkSelectors,
  dispatchCanvasDragPointer,
  findFloatingToolbarObstacleElements,
  findRoot,
  findToastStackElement,
  findToolbarSlot,
  isEditorChrome,
  observeStructure,
  pressEnterToEditLabel,
  readChrome,
} from "./domBridge";

const build = (html: string): HTMLElement => {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
};

afterEach(() => {
  document.body.innerHTML = "";
  resetDiagnostics();
});

describe("finding the editor's root", () => {
  it("finds it inside our own container", () => {
    const container = build('<div class="excalidraw"></div>');
    const result = findRoot(container);
    expect(result.ok).toBe(true);
  });

  it("reports editor-changed when the class is gone, rather than falling back silently", () => {
    const heard = vi.fn();
    onDiagnostic(heard);
    const result = findRoot(build("<div></div>"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("editor-changed");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("finding the toolbar", () => {
  it("prefers the horizontal row, because the island stacks vertically", () => {
    const container = build(
      '<div class="App-toolbar"><div class="Stack_horizontal" id="row"></div></div>',
    );
    const result = findToolbarSlot(container);
    expect(result.ok && result.value.id).toBe("row");
  });

  it("falls back to the island when the row is gone", () => {
    const container = build('<div class="App-toolbar" id="island"></div>');
    const result = findToolbarSlot(container);
    expect(result.ok && result.value.id).toBe("island");
  });

  it("treats a missing toolbar as a fallback, not a defect", () => {
    // Zen mode and view mode have no tool row at all.
    const result = findToolbarSlot(build("<div></div>"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported");
      expect(result.fallback).toBe("main-menu");
    }
  });

  it("does not reach into another editor on the same page", () => {
    build('<div class="App-toolbar" id="theirs"></div>');
    const mine = build("<div></div>");
    expect(findToolbarSlot(mine).ok).toBe(false);
  });
});

describe("finding floating-toolbar obstacles", () => {
  it("returns the tool island and the optional selected-shape panel in this editor only", () => {
    build('<div class="App-toolbar" id="theirs"></div>');
    const mine = build(
      '<div class="App-toolbar" id="toolbar"></div><div class="App-menu__left" id="properties"></div>',
    );

    expect(findFloatingToolbarObstacleElements(mine).map(({ id }) => id)).toEqual([
      "toolbar",
      "properties",
    ]);
  });

  it("does not invent the optional properties panel when it is closed", () => {
    const root = build('<div class="App-toolbar" id="toolbar"></div>');
    expect(findFloatingToolbarObstacleElements(root).map(({ id }) => id)).toEqual(["toolbar"]);
  });

  // NIL-589: the Sonner toast stack is `position: fixed` at a screen corner,
  // entirely unrelated to where a floating toolbar sits in the pannable
  // canvas -- see this obstacle's own comment in domBridge.ts for why a
  // covered "Next page" click read as an unresponsive button.
  it("treats an empty toast stack as no obstacle", () => {
    const root = build('<div class="App-toolbar" id="toolbar"></div>');
    build('<div data-sonner-toaster id="toaster"></div>');
    expect(findFloatingToolbarObstacleElements(root).map(({ id }) => id)).toEqual(["toolbar"]);
  });

  it("treats an active toast stack as an obstacle", () => {
    const root = build('<div class="App-toolbar" id="toolbar"></div>');
    build('<div data-sonner-toaster id="toaster"><li data-sonner-toast id="toast"></li></div>');
    expect(findFloatingToolbarObstacleElements(root).map(({ id }) => id)).toEqual([
      "toolbar",
      "toaster",
    ]);
  });

  it("is not scoped to root: the toaster lives outside the editor's own container", () => {
    const root = build('<div class="App-toolbar" id="toolbar"></div>');
    // Appended as a page-level sibling, not inside `root` -- the same
    // relationship EditorView.tsx has between its Toaster and excalidrawRoot.
    build('<div data-sonner-toaster id="toaster"><li data-sonner-toast></li></div>');
    expect(findFloatingToolbarObstacleElements(root).some((el) => el.id === "toaster")).toBe(true);
  });
});

describe("finding the toast stack element to observe for resize", () => {
  it("returns the toaster container even with no toast showing", () => {
    build('<div data-sonner-toaster id="toaster"></div>');
    expect(findToastStackElement()?.id).toBe("toaster");
  });

  it("returns null when no Toaster is mounted", () => {
    expect(findToastStackElement()).toBeNull();
  });
});

describe("reading the editor's chrome", () => {
  it("sees zen mode through the tool row", () => {
    expect(readChrome(build('<div class="App-toolbar zen-mode"></div>')).zenMode).toBe(true);
  });

  it("sees zen mode in view mode too, where there is no tool row", () => {
    expect(readChrome(build('<div class="disable-zen-mode--visible"></div>')).zenMode).toBe(true);
  });

  it("sees the mobile layout", () => {
    expect(readChrome(build('<div class="excalidraw--mobile"></div>')).mobile).toBe(true);
  });
});

describe("telling the editor's chrome from its canvas", () => {
  it("recognises the menu layer", () => {
    const container = build('<div class="layer-ui__wrapper"><button id="b"></button></div>');
    expect(isEditorChrome(container.querySelector("#b"))).toBe(true);
  });

  it("does not claim a plain canvas", () => {
    const container = build("<canvas id='c'></canvas>");
    expect(isEditorChrome(container.querySelector("#c"))).toBe(false);
  });
});

describe("starting the label editor", () => {
  it("sends Enter and resolves once the editor really is editing", async () => {
    const container = build('<div class="excalidraw"></div>');
    const root = container.querySelector(".excalidraw")!;
    let editing = false;
    root.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") editing = true;
    });

    const result = await pressEnterToEditLabel(container, () => editing, { timeoutMs: 500 });
    expect(result.ok).toBe(true);
  });

  it("waits for the real state instead of checking one frame later", async () => {
    // The editor opens through React state, which does not commit in the same
    // tick. A check a frame after the key is what made the old warning cry wolf.
    const container = build('<div class="excalidraw"></div>');
    let editing = false;
    setTimeout(() => {
      editing = true;
    }, 120);

    const result = await pressEnterToEditLabel(container, () => editing, { timeoutMs: 2000 });
    expect(result.ok).toBe(true);
  });

  it("reports editor-changed when it genuinely never opens", async () => {
    const heard = vi.fn();
    onDiagnostic(heard);
    const container = build('<div class="excalidraw"></div>');

    const result = await pressEnterToEditLabel(container, () => false, { timeoutMs: 80 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("editor-changed");
      expect(result.fallback).toBe("manual-selection");
    }
    expect(heard).toHaveBeenCalled();
  });
});

describe("watching the editor rebuild itself", () => {
  it("reports a class change, which is how zen mode arrives", async () => {
    const container = build('<div class="App-toolbar"></div>');
    const seen = vi.fn();
    const stop = observeStructure(container, seen);

    container.querySelector(".App-toolbar")!.classList.add("zen-mode");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toHaveBeenCalled();
    stop();
  });

  it("hands back a no-op when there is no container", () => {
    expect(() => observeStructure(null, () => {})()).not.toThrow();
  });
});

describe("continuing a delayed canvas drag", () => {
  it("replays move and release with the original pointer identity", () => {
    const heard: Array<{ type: string; buttons: number; pointerId: number }> = [];
    const listener = (event: PointerEvent) => {
      heard.push({ type: event.type, buttons: event.buttons, pointerId: event.pointerId });
    };
    window.addEventListener("pointermove", listener);
    window.addEventListener("pointerup", listener);

    const pointer = { clientX: 20, clientY: 30, pointerId: 7, pointerType: "pen" };
    dispatchCanvasDragPointer("pointermove", pointer);
    dispatchCanvasDragPointer("pointerup", pointer);

    expect(heard).toEqual([
      { type: "pointermove", buttons: 1, pointerId: 7 },
      { type: "pointerup", buttons: 0, pointerId: 7 },
    ]);
    window.removeEventListener("pointermove", listener);
    window.removeEventListener("pointerup", listener);
  });
});

describe("checking the selectors against a build", () => {
  it("names the ones that stopped matching", () => {
    const container = build('<div class="excalidraw"></div>');
    const { checked, missing } = checkSelectors(container);
    expect(checked).toBeGreaterThan(0);
    expect(missing).toContain("toolbar");
    expect(missing).not.toContain("root");
  });
});
