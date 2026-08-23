import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (elements: Array<Record<string, unknown>>) =>
    elements.map((element, index) => ({ id: `element-${index}`, ...element })),
}));

import {
  ASSET_WIDGET_LINK,
  createAssetWidgetElement,
  createPdfWidgetElement,
  getAssetWidgetData,
  getPdfWidgetAssetId,
  PDF_WIDGET_LINK,
} from "./pdfWidgetElements";

describe("PDF widget elements", () => {
  it("stores the widget under this application's namespace, and nothing else", () => {
    const element = createPdfWidgetElement({
      assetId: "asset-123",
      x: 400,
      y: 500,
    });

    expect(element.type).toBe("embeddable");
    expect(element.link).toBe(PDF_WIDGET_LINK);
    expect(element.customData).toEqual({
      excalidash: { schemaVersion: 2, widget: { kind: "pdf", assetId: "asset-123" } },
    });
    expect(getPdfWidgetAssetId(element)).toBe("asset-123");
  });

  it("uses the generic asset schema for text-backed widgets", () => {
    const element = createAssetWidgetElement({
      assetId: "asset-md",
      widgetKind: "markdown",
      x: 100,
      y: 200,
    });

    expect(element.link).toBe(ASSET_WIDGET_LINK);
    expect(getAssetWidgetData(element)).toEqual({
      widgetKind: "markdown",
      assetId: "asset-md",
    });
    expect(getPdfWidgetAssetId(element)).toBeNull();
  });

  /**
   * A widget has to stay a widget when somebody else writes on the element.
   *
   * The recognition used to require customData to have exactly three keys, so
   * any fourth one -- a namespace, sticky metadata, anything a future writer
   * adds -- made it unrecognisable. That is not a cosmetic failure: an
   * unrecognised widget renders as Excalidraw's own embeddable for an
   * excalidash:// link, which is an empty box with a URL.
   */
  describe("recognition survives a foreign key on the element", () => {
    const widget = (customData: Record<string, unknown>) => ({
      type: "embeddable",
      link: ASSET_WIDGET_LINK,
      customData,
    });
    const stored = { schemaVersion: 2, widget: { kind: "pdf", assetId: "asset-1" } };
    const read = { widgetKind: "pdf", assetId: "asset-1" };

    it("still recognises the widget beside an unrelated key", () => {
      expect(getAssetWidgetData(widget({ excalidash: stored, somebodyElse: { note: 1 } }))).toEqual(
        read,
      );
    });

    it("still recognises the widget on an element that is also a note", () => {
      const both = {
        schemaVersion: 2,
        widget: stored.widget,
        sticky: { color: "yellow", ink: "#422006", width: 200, height: 200, fontSize: 20 },
      };
      expect(getAssetWidgetData(widget({ excalidash: both }))).toEqual(read);
    });

    it("still rejects data that is actually wrong", () => {
      expect(
        getAssetWidgetData(widget({ excalidash: { ...stored, schemaVersion: 99 } })),
      ).toBeNull();
      expect(
        getAssetWidgetData(
          widget({
            excalidash: { schemaVersion: 2, widget: { kind: "spreadsheet", assetId: "a" } },
          }),
        ),
      ).toBeNull();
      expect(
        getAssetWidgetData(
          widget({ excalidash: { schemaVersion: 2, widget: { kind: "pdf", assetId: "" } } }),
        ),
      ).toBeNull();
      expect(getAssetWidgetData(widget({ excalidash: { schemaVersion: 2 } }))).toBeNull();
    });
  });
});
