import { describe, expect, it } from "vitest";

import { createWidgetCapability, exportSubstitute, WIDGET_LINK } from "./widgets";
import { withExcalidashData } from "./customData";
import type { ElementId, ElementSummary } from "./types";

const summary = (over: Partial<ElementSummary> = {}): ElementSummary => ({
  id: "e1" as ElementId,
  type: "embeddable",
  x: 0,
  y: 0,
  width: 480,
  height: 680,
  angle: 0,
  isDeleted: false,
  frameId: null,
  containerId: null,
  link: WIDGET_LINK,
  customData: withExcalidashData({}, { widget: { kind: "pdf", assetId: "a1" } }),
  ...over,
});

const capability = (canEdit: boolean) =>
  createWidgetCapability(() => ({ getAppState: () => ({}), canEdit: () => canEdit }));

describe("identifying a widget", () => {
  it("recognises one of ours", () => {
    const result = capability(true).identify(summary());
    expect(result.ok && result.value).toEqual({ kind: "pdf", schemaVersion: 2, assetId: "a1" });
  });

  it("does not claim an embeddable that is somebody else's", () => {
    const result = capability(true).identify(summary({ link: "https://youtube.com/watch" }));
    expect(result.ok && result.value).toBeNull();
  });

  it("does not claim a plain rectangle carrying our data", () => {
    const result = capability(true).identify(summary({ type: "rectangle" }));
    expect(result.ok && result.value).toBeNull();
  });

  it("reports nothing rather than failing for an element with no record", () => {
    const result = capability(true).identify(summary({ customData: null }));
    expect(result.ok && result.value).toBeNull();
  });
});

describe("the read-only interaction contract (NIL-311)", () => {
  it("reports interactive for a viewer who may edit", () => {
    const result = capability(true).interactionMode();
    expect(result.ok && result.value).toBe("interactive");
  });

  it("reports read-only for a viewer who may not", () => {
    // Excalidraw activates an embeddable only on double click and guards that
    // path with !viewModeEnabled, and the host sets viewModeEnabled={!canEdit}.
    // A read-only visitor can never reach the widget's own controls.
    const result = capability(false).interactionMode();
    expect(result.ok && result.value).toBe("read-only");
  });

  it("falls back to a static widget when there is no editor to ask", () => {
    const result = createWidgetCapability(() => null).interactionMode();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fallback).toBe("static-widget");
  });
});

describe("the export substitute (NIL-277)", () => {
  it("keeps the widget's place on the board", () => {
    const element = summary({ x: 100, y: 200, width: 480, height: 680 });
    const substitute = exportSubstitute(element, {
      kind: "pdf",
      schemaVersion: 2,
      assetId: "a1",
    });
    expect(substitute).toMatchObject({ x: 100, y: 200, width: 480, height: 680 });
  });

  it("is a plain rectangle, because an embeddable exports as an empty box", () => {
    const substitute = exportSubstitute(summary(), {
      kind: "markdown",
      schemaVersion: 2,
      assetId: "a1",
    });
    expect(substitute.type).toBe("rectangle");
    expect(substitute.link).toBeUndefined();
  });

  it("says what the reader is looking at", () => {
    const substitute = exportSubstitute(summary(), {
      kind: "markdown",
      schemaVersion: 2,
      assetId: "a1",
    });
    expect((substitute.label as { text: string }).text).toBe("MARKDOWN document");
  });

  it("does not reuse the original id, which would collide in the cloned scene", () => {
    const substitute = exportSubstitute(summary(), {
      kind: "pdf",
      schemaVersion: 2,
      assetId: "a1",
    });
    expect(substitute.id).not.toBe("e1");
  });
});

describe("describing a new widget", () => {
  it("centres it on the point and carries the namespaced record", () => {
    const result = capability(true).describe(
      { kind: "pdf", schemaVersion: 2, assetId: "a1" },
      { x: 1000, y: 1000 },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "insert") {
      const [element] = result.value.elements;
      expect(element.x).toBe(1000 - 480 / 2);
      expect(element.link).toBe(WIDGET_LINK);
      expect(element.customData).toEqual({
        excalidash: { schemaVersion: 2, widget: { kind: "pdf", assetId: "a1" } },
      });
    }
  });
});
