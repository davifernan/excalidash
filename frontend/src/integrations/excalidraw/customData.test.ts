import { describe, expect, it } from "vitest";

import {
  NAMESPACE,
  SCHEMA_VERSION,
  readExcalidashData,
  readMindMap,
  readMindMapProjection,
  readSticky,
  readWidget,
  withExcalidashData,
} from "./customData";

const sticky = { color: "yellow", ink: "#422006", width: 180, height: 180, fontSize: 20 };
const widget = { kind: "pdf" as const, assetId: "asset-1" };
const mindMap = { mapId: "map-1", parentId: "node-parent", orderKey: "0002" };
const mindMapProjection = { mapId: "map-1", childId: "node-child" };

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

  it("reads the semantic relationship from the node and the projection marker from the arrow", () => {
    const data = readExcalidashData(
      element({ schemaVersion: SCHEMA_VERSION, mindMap, mindMapProjection }),
    );
    expect(data).toEqual({
      schemaVersion: SCHEMA_VERSION,
      mindMap,
      mindMapProjection,
    });
    expect(readMindMap(element({ schemaVersion: SCHEMA_VERSION, mindMap }))).toEqual(mindMap);
    expect(
      readMindMapProjection(element({ schemaVersion: SCHEMA_VERSION, mindMapProjection })),
    ).toEqual(mindMapProjection);
  });

  it("accepts a root relation only with an explicit null parent", () => {
    const root = { mapId: "map-1", parentId: null, orderKey: "root" };
    expect(readMindMap(element({ schemaVersion: SCHEMA_VERSION, mindMap: root }))).toEqual(root);
    expect(
      readMindMap(
        element({
          schemaVersion: SCHEMA_VERSION,
          mindMap: { mapId: "map-1", orderKey: "root" },
        }),
      ),
    ).toBeNull();
  });

  it("refuses incomplete or empty semantic and projection identifiers", () => {
    expect(
      readMindMap(
        element({
          schemaVersion: SCHEMA_VERSION,
          mindMap: { mapId: "", parentId: null, orderKey: "root" },
        }),
      ),
    ).toBeNull();
    expect(
      readMindMapProjection(
        element({
          schemaVersion: SCHEMA_VERSION,
          mindMapProjection: { mapId: "map-1", childId: "" },
        }),
      ),
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
      const written = withExcalidashData({}, { sticky, widget, mindMap, mindMapProjection });
      expect(readExcalidashData({ customData: written })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        sticky,
        widget,
        mindMap,
        mindMapProjection,
      });
    });

    it("survives an Excalidraw JSON serialization round-trip", () => {
      const drawing = {
        type: "excalidraw",
        version: 2,
        elements: [
          {
            id: "node-child",
            type: "rectangle",
            customData: withExcalidashData({}, { mindMap }),
          },
          {
            id: "edge-child",
            type: "arrow",
            customData: withExcalidashData({}, { mindMapProjection }),
          },
        ],
      };
      const restored = JSON.parse(JSON.stringify(drawing)) as typeof drawing;

      expect(readMindMap(restored.elements[0])).toEqual(mindMap);
      expect(readMindMapProjection(restored.elements[1])).toEqual(mindMapProjection);
      expect(restored.elements.map((entry) => entry.type)).toEqual(["rectangle", "arrow"]);
    });

    it("can remove semantic data without disturbing another record or foreign customData", () => {
      const first = withExcalidashData(
        { customData: { foreign: { retained: true } } },
        { widget, mindMap, mindMapProjection },
      );
      const second = withExcalidashData(
        { customData: first },
        { mindMap: null, mindMapProjection: null },
      );

      expect(second.foreign).toEqual({ retained: true });
      expect(readExcalidashData({ customData: second })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        widget,
      });
    });

    it("does not silently erase malformed semantic data while updating another record", () => {
      const malformed = { mapId: "map-1", parentId: 17, orderKey: "a" };
      const original = element({ schemaVersion: SCHEMA_VERSION, mindMap: malformed });
      const written = withExcalidashData(original, { widget });

      expect((written[NAMESPACE] as Record<string, unknown>).mindMap).toEqual(malformed);
      expect(readMindMap({ customData: written })).toBeNull();
      expect(readWidget({ customData: written })).toEqual(widget);
    });
  });
});
