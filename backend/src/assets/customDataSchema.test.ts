import { describe, expect, it } from "vitest";

import {
  NAMESPACE,
  SCHEMA_VERSION,
  readMindMapProjectionRecord,
  readMindMapRecord,
  readWidgetRecord,
} from "./customDataSchema";

const element = (record: Record<string, unknown>) => ({
  customData: { [NAMESPACE]: { schemaVersion: SCHEMA_VERSION, ...record } },
});

describe("server customData schema", () => {
  it("reads node authority and arrow projection independently", () => {
    const mindMap = { mapId: "map-1", parentId: "root", orderKey: "0001" };
    const projection = { mapId: "map-1", childId: "child" };

    expect(readMindMapRecord(element({ mindMap }))).toEqual(mindMap);
    expect(readMindMapProjectionRecord(element({ mindMapProjection: projection }))).toEqual(
      projection,
    );
  });

  it("accepts only an explicit null for a root parent", () => {
    expect(
      readMindMapRecord(element({ mindMap: { mapId: "map-1", parentId: null, orderKey: "root" } })),
    ).toEqual({ mapId: "map-1", parentId: null, orderKey: "root" });
    expect(
      readMindMapRecord(element({ mindMap: { mapId: "map-1", orderKey: "root" } })),
    ).toBeNull();
  });

  it("rejects empty identifiers and unknown schema versions", () => {
    expect(
      readMindMapRecord(element({ mindMap: { mapId: "", parentId: null, orderKey: "root" } })),
    ).toBeNull();
    expect(
      readMindMapProjectionRecord(element({ mindMapProjection: { mapId: "map-1", childId: "" } })),
    ).toBeNull();
    expect(
      readMindMapRecord({
        customData: {
          [NAMESPACE]: {
            schemaVersion: 999,
            mindMap: { mapId: "map-1", parentId: null, orderKey: "root" },
          },
        },
      }),
    ).toBeNull();
  });

  it("keeps the existing widget reader working beside a mind-map record", () => {
    expect(
      readWidgetRecord(
        element({
          widget: { kind: "pdf", assetId: "asset-1" },
          mindMap: { mapId: "map-1", parentId: null, orderKey: "root" },
        }),
      ),
    ).toEqual({ kind: "pdf", assetId: "asset-1" });
  });
});
