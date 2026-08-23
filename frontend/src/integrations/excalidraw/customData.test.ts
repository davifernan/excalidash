import { describe, expect, it } from "vitest";

import {
  NAMESPACE,
  SCHEMA_VERSION,
  readExcalidashData,
  readSticky,
  readWidget,
  withExcalidashData,
} from "./customData";

const sticky = { color: "yellow", ink: "#422006", width: 180, height: 180, fontSize: 20 };
const widget = { kind: "pdf" as const, assetId: "asset-1" };

const element = (own: unknown, rest: Record<string, unknown> = {}) => ({
  customData: { ...rest, [NAMESPACE]: own },
});

describe("the customData schema", () => {
  it("reads a record that carries both a note and a widget", () => {
    const data = readExcalidashData(element({ schemaVersion: SCHEMA_VERSION, sticky, widget }));
    expect(data).toEqual({ schemaVersion: SCHEMA_VERSION, sticky, widget });
  });

  it("ignores keys belonging to somebody else", () => {
    expect(
      readSticky(element({ schemaVersion: SCHEMA_VERSION, sticky }, { other: { a: 1 } })),
    ).toEqual(sticky);
  });

  it("refuses a record from a different schema version", () => {
    expect(readExcalidashData(element({ schemaVersion: 99, sticky }))).toBeNull();
  });

  it("refuses a note with a field missing rather than filling it in", () => {
    const { fontSize: _dropped, ...incomplete } = sticky;
    expect(readSticky(element({ schemaVersion: SCHEMA_VERSION, sticky: incomplete }))).toBeNull();
  });

  it("refuses a widget kind it does not know", () => {
    expect(
      readWidget(
        element({ schemaVersion: SCHEMA_VERSION, widget: { kind: "spreadsheet", assetId: "a" } }),
      ),
    ).toBeNull();
  });

  it("refuses an empty asset id, which would name no document", () => {
    expect(
      readWidget(element({ schemaVersion: SCHEMA_VERSION, widget: { kind: "pdf", assetId: "" } })),
    ).toBeNull();
  });

  it("returns nothing for an element that carries neither", () => {
    expect(readExcalidashData(element({ schemaVersion: SCHEMA_VERSION }))).toBeNull();
    expect(readExcalidashData({ customData: {} })).toBeNull();
    expect(readExcalidashData({})).toBeNull();
    expect(readExcalidashData(null)).toBeNull();
  });

  describe("writing", () => {
    it("stamps the current schema version", () => {
      const written = withExcalidashData({}, { sticky });
      expect((written[NAMESPACE] as { schemaVersion: number }).schemaVersion).toBe(SCHEMA_VERSION);
    });

    it("leaves another writer's keys alone", () => {
      const written = withExcalidashData({ customData: { other: { a: 1 } } }, { widget });
      expect(written.other).toEqual({ a: 1 });
      expect(readWidget({ customData: written })).toEqual(widget);
    });

    it("keeps the half it was not asked to change", () => {
      const first = withExcalidashData({}, { sticky });
      const second = withExcalidashData({ customData: first }, { widget });
      expect(readExcalidashData({ customData: second })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        sticky,
        widget,
      });
    });

    it("does not mutate the element it was handed", () => {
      const original = { customData: { [NAMESPACE]: { schemaVersion: SCHEMA_VERSION, sticky } } };
      const snapshot = JSON.stringify(original);
      withExcalidashData(original, { widget });
      expect(JSON.stringify(original)).toBe(snapshot);
    });

    it("round-trips what it wrote", () => {
      const written = withExcalidashData({}, { sticky, widget });
      expect(readExcalidashData({ customData: written })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        sticky,
        widget,
      });
    });
  });
});
