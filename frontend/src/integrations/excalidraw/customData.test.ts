import { describe, expect, it } from "vitest";

import {
  NAMESPACE,
  SCHEMA_VERSION,
  readExcalidashData,
  readNodeState,
  readSticky,
  readWidget,
  withExcalidashData,
} from "./customData";

const sticky = { color: "yellow", ink: "#422006", width: 180, height: 180, fontSize: 20 };
const widget = { kind: "pdf" as const, assetId: "asset-1" };
const nodeState = { pinned: true, collapsed: true };

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

  it("reads pin/collapse state off nodeState", () => {
    const data = readExcalidashData(element({ schemaVersion: SCHEMA_VERSION, nodeState }));
    expect(data).toEqual({ schemaVersion: SCHEMA_VERSION, nodeState });
    expect(readNodeState(element({ schemaVersion: SCHEMA_VERSION, nodeState }))).toEqual(nodeState);
  });

  it("returns nothing for an element that carries neither", () => {
    expect(readExcalidashData(element({ schemaVersion: SCHEMA_VERSION }))).toBeNull();
    expect(readExcalidashData({ customData: {} })).toBeNull();
    expect(readExcalidashData({})).toBeNull();
    expect(readExcalidashData(null)).toBeNull();
  });

  // NIL-593, Schnitt 2: the mind-map tool's own structural fields
  // (mapId/parentId/orderKey) are torn down. An element that still carries
  // them in stored JSON must neither crash this reader nor have them come
  // back out as structure -- readExcalidashData has simply never heard of
  // them.
  describe("an existing board with old mind-map data (NIL-593 teardown)", () => {
    const legacyMindMap = { mapId: "map-1", parentId: "node-parent", orderKey: "0002" };
    const legacyProjection = { mapId: "map-1", childId: "node-child" };

    it("does not throw and reports no excalidash data for a node whose only record was the dead structure", () => {
      expect(() =>
        readExcalidashData(element({ schemaVersion: SCHEMA_VERSION, mindMap: legacyMindMap })),
      ).not.toThrow();
      expect(
        readExcalidashData(element({ schemaVersion: SCHEMA_VERSION, mindMap: legacyMindMap })),
      ).toBeNull();
    });

    it("does not throw for the old projection marker on an arrow either", () => {
      expect(() =>
        readExcalidashData(
          element({ schemaVersion: SCHEMA_VERSION, mindMapProjection: legacyProjection }),
        ),
      ).not.toThrow();
    });

    it("never surfaces mapId/parentId as a field of ExcalidashData -- there is no reader left that returns them", () => {
      const data = readExcalidashData(
        element({ schemaVersion: SCHEMA_VERSION, sticky, mindMap: legacyMindMap }),
      );
      expect(data).toEqual({ schemaVersion: SCHEMA_VERSION, sticky });
      expect(data).not.toHaveProperty("mindMap");
    });

    it("readNodeState falls back to the old pinned/collapsed booleans once, but never to mapId/parentId", () => {
      const legacy = { mapId: "map-1", parentId: null, orderKey: "root", pinned: true };
      const state = readNodeState(element({ schemaVersion: SCHEMA_VERSION, mindMap: legacy }));
      expect(state).toEqual({ pinned: true });
    });

    it("readNodeState prefers the new nodeState field once a client has written one", () => {
      const legacy = { mapId: "map-1", parentId: null, orderKey: "root", pinned: true };
      const state = readNodeState(
        element({
          schemaVersion: SCHEMA_VERSION,
          mindMap: legacy,
          nodeState: { collapsed: true },
        }),
      );
      expect(state).toEqual({ collapsed: true });
    });

    it("readNodeState returns null, not an empty object, when neither shape carries a true flag", () => {
      expect(readNodeState(element({ schemaVersion: SCHEMA_VERSION }))).toBeNull();
      expect(
        readNodeState(
          element({
            schemaVersion: SCHEMA_VERSION,
            mindMap: { mapId: "map-1", parentId: null, orderKey: "root" },
          }),
        ),
      ).toBeNull();
    });

    it("a patch that touches an unrelated field lets the dead structure fall away, not round-trip forever", () => {
      const original = element({ schemaVersion: SCHEMA_VERSION, mindMap: legacyMindMap });
      const written = withExcalidashData(original, { widget });
      expect((written[NAMESPACE] as Record<string, unknown>).mindMap).toBeUndefined();
      expect(readWidget({ customData: written })).toEqual(widget);
    });
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

    it("round-trips what it wrote, including nodeState", () => {
      const written = withExcalidashData({}, { sticky, widget, nodeState });
      expect(readExcalidashData({ customData: written })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        sticky,
        widget,
        nodeState,
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
            customData: withExcalidashData({}, { nodeState }),
          },
        ],
      };
      const restored = JSON.parse(JSON.stringify(drawing)) as typeof drawing;

      expect(readNodeState(restored.elements[0])).toEqual(nodeState);
      expect(restored.elements.map((entry) => entry.type)).toEqual(["rectangle"]);
    });

    it("can remove nodeState without disturbing another record or foreign customData", () => {
      const first = withExcalidashData(
        { customData: { foreign: { retained: true } } },
        { widget, nodeState },
      );
      const second = withExcalidashData({ customData: first }, { nodeState: null });

      expect(second.foreign).toEqual({ retained: true });
      expect(readExcalidashData({ customData: second })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        widget,
      });
    });
  });
});
