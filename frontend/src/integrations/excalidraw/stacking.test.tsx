import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ElementStackingBoundary } from "./ElementStackingBoundary";
import { reverseElementStack, stacking } from "./stacking";

describe("Excalidraw stacking adapter", () => {
  it("translates product roles to named adapter variables", () => {
    expect(stacking.widgetControls).toBe("var(--excalidash-z-widget-controls)");
    expect(stacking.modal).toBe("var(--excalidash-z-modal)");
    expect(stacking.popup).toBe("var(--excalidash-z-popup)");
    expect(stacking.notification).toBe("var(--excalidash-z-notification)");
    expect(stacking.chrome).toBe("var(--excalidash-z-chrome)");
    expect(reverseElementStack(2)).toEqual({
      zIndex: "calc(var(--excalidash-z-element-overlay) - 2)",
    });
  });

  it("moves embeddable content with its selected frame and restores the package wrapper", () => {
    const view = render(
      <div className="excalidraw__embeddable-container" style={{ zIndex: "17" }}>
        <ElementStackingBoundary elevated={false}>content</ElementStackingBoundary>
      </div>,
    );
    const container = view.container.querySelector<HTMLElement>(
      ".excalidraw__embeddable-container",
    );
    expect(container?.style.zIndex).toBe(stacking.elementContent);

    view.rerender(
      <div className="excalidraw__embeddable-container" style={{ zIndex: "17" }}>
        <ElementStackingBoundary elevated>content</ElementStackingBoundary>
      </div>,
    );
    expect(container?.style.zIndex).toBe(stacking.elementOverlay);

    view.unmount();
    expect(container?.style.zIndex).toBe("17");
  });
});
