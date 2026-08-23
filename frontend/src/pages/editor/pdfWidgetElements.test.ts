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
  it("stores only the schema, widget kind, and asset id in customData", () => {
    const element = createPdfWidgetElement({
      assetId: "asset-123",
      x: 400,
      y: 500,
    });

    expect(element.type).toBe("embeddable");
    expect(element.link).toBe(PDF_WIDGET_LINK);
    expect(element.customData).toEqual({
      schemaVersion: 1,
      widgetKind: "pdf",
      assetId: "asset-123",
    });
    expect(Object.keys(element.customData ?? {})).toHaveLength(3);
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
      schemaVersion: 1,
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
    const valid = { schemaVersion: 1, widgetKind: "pdf" as const, assetId: "asset-1" };

    it("still recognises the widget beside an unrelated key", () => {
      expect(getAssetWidgetData(widget({ ...valid, somebodyElse: { note: 1 } }))).toEqual(valid);
    });

    it("still recognises the widget beside sticky metadata", () => {
      expect(getAssetWidgetData(widget({ ...valid, excalidashSticky: { v: 1 } }))).toEqual(valid);
    });

    it("still rejects data that is actually wrong", () => {
      expect(getAssetWidgetData(widget({ ...valid, schemaVersion: 99 }))).toBeNull();
      expect(getAssetWidgetData(widget({ ...valid, widgetKind: "spreadsheet" }))).toBeNull();
      expect(getAssetWidgetData(widget({ ...valid, assetId: "" }))).toBeNull();
      expect(getAssetWidgetData(widget({ schemaVersion: 1, widgetKind: "pdf" }))).toBeNull();
    });
  });
});
