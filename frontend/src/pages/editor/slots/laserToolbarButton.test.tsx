import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { describe, expect, it, vi, afterEach } from "vitest";
import { LaserToolbarButton } from "./laserToolbarButton";
import { StickyToolbarButton } from "../../../sticky/StickyToolbarButton";
import { STICKY_COLORS } from "../../../sticky/stickyNote";
import type { InteractionCapability } from "../../../integrations/excalidraw/capabilities";

const buildContainer = () => {
  const container = document.createElement("div");
  container.innerHTML = `
    <div class="excalidraw">
      <div class="App-toolbar">
        <div class="Stack_horizontal"></div>
      </div>
    </div>
  `;
  document.body.appendChild(container);
  return container;
};

const interactionStub: InteractionCapability = {
  read: () => ({ ok: true, value: { activeTool: { type: "selection" } } }) as any,
  subscribe: () => () => {},
  setActiveTool: () => ({ ok: true, value: undefined }) as any,
};

describe("LaserToolbarButton keybinding hint", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders the shortcut through the same ToolIcon__keybinding element Sticky Note uses, not a redrawn badge", () => {
    const laserContainer = buildContainer();
    const laserRef = createRef<HTMLDivElement>();
    (laserRef as any).current = laserContainer;
    const laserRoot = createRoot(laserContainer.ownerDocument.createElement("div"));

    act(() => {
      laserRoot.render(
        <LaserToolbarButton containerRef={laserRef as any} interaction={interactionStub} />,
      );
    });

    const stickyContainer = buildContainer();
    const stickyRef = createRef<HTMLDivElement>();
    (stickyRef as any).current = stickyContainer;
    const stickyRoot = createRoot(stickyContainer.ownerDocument.createElement("div"));

    act(() => {
      stickyRoot.render(
        <StickyToolbarButton
          containerRef={stickyRef as any}
          armed={false}
          color={STICKY_COLORS[0]}
          onArm={() => {}}
        />,
      );
    });

    const laserKeybinding = laserContainer
      .querySelector('[data-testid="toolbar-LaserPointer"]')
      ?.parentElement?.querySelector(".ToolIcon__keybinding");
    const stickyKeybinding = stickyContainer.querySelector(
      '[data-testid="toolbar-sticky"] .ToolIcon__keybinding',
    );

    expect(laserKeybinding).not.toBeNull();
    expect(stickyKeybinding).not.toBeNull();
    expect(laserKeybinding?.className).toBe(stickyKeybinding?.className);

    act(() => {
      laserRoot.unmount();
      stickyRoot.unmount();
    });
  });
});
