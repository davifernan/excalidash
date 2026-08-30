import { describe, expect, it } from "vitest";

import {
  NAMESPACE,
  SCHEMA_VERSION,
  readExcalidashData,
  readOrchestratorThreadAnchor,
  readSticky,
  readWidget,
  withExcalidashData,
} from "./customData";

const sticky = { color: "yellow", ink: "#422006", width: 180, height: 180 };
const widget = { kind: "pdf" as const, assetId: "asset-1" };
const orchestratorThread = { threadId: "thread-1", title: "Release coordination" };

const element = (own: unknown, rest: Record<string, unknown> = {}) => ({
  customData: { ...rest, [NAMESPACE]: own },
});

describe("the customData schema", () => {
  it("reads a record that carries both a note and a widget", () => {
    const data = readExcalidashData(element({ schemaVersion: SCHEMA_VERSION, sticky, widget }));
    expect(data).toEqual({ schemaVersion: SCHEMA_VERSION, sticky, widget });
  });

  it("round-trips a stable orchestrator thread anchor without storing authority", () => {
    const suppliedAtRuntime = {
      ...orchestratorThread,
      permissions: ["board:write"],
      dispatch: { target: "context-1" },
      lease: { holder: "agent-1" },
    } as typeof orchestratorThread;
    const written = withExcalidashData({}, { orchestratorThread: suppliedAtRuntime });
    expect(readOrchestratorThreadAnchor({ customData: written })).toEqual(orchestratorThread);
    expect(written).toHaveProperty(`${NAMESPACE}.orchestratorThread`, orchestratorThread);
  });

  it("refuses a malformed orchestrator thread reference", () => {
    expect(
      readOrchestratorThreadAnchor(
        element({
          schemaVersion: SCHEMA_VERSION,
          orchestratorThread: { threadId: "", title: "Release coordination" },
        }),
      ),
    ).toBeNull();
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
    const { height: _dropped, ...incomplete } = sticky;
    expect(readSticky(element({ schemaVersion: SCHEMA_VERSION, sticky: incomplete }))).toBeNull();
  });

  it("drops the legacy stored font size because it is now derived", () => {
    expect(
      readSticky(element({ schemaVersion: SCHEMA_VERSION, sticky: { ...sticky, fontSize: 12 } })),
    ).toEqual(sticky);
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

    it("tolerates but never surfaces retired nodeState data", () => {
      const old = element({
        schemaVersion: SCHEMA_VERSION,
        nodeState: { pinned: true, collapsed: true },
      });
      expect(() => readExcalidashData(old)).not.toThrow();
      expect(readExcalidashData(old)).toBeNull();
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

    it("round-trips the records it owns", () => {
      const written = withExcalidashData({}, { sticky, widget });
      expect(readExcalidashData({ customData: written })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        sticky,
        widget,
      });
    });

    it("drops retired nodeState on the next owned write without disturbing foreign customData", () => {
      const old = {
        customData: {
          foreign: { retained: true },
          [NAMESPACE]: { schemaVersion: SCHEMA_VERSION, nodeState: { pinned: true } },
        },
      };
      const written = withExcalidashData(old, { widget });

      expect(written.foreign).toEqual({ retained: true });
      expect((written[NAMESPACE] as Record<string, unknown>).nodeState).toBeUndefined();
      expect(readExcalidashData({ customData: written })).toEqual({
        schemaVersion: SCHEMA_VERSION,
        widget,
      });
    });
  });
});
