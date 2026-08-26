import { describe, expect, it } from "vitest";

import { NAMESPACE, SCHEMA_VERSION, readWidgetRecord } from "./customDataSchema";

const element = (record: Record<string, unknown>) => ({
  customData: { [NAMESPACE]: { schemaVersion: SCHEMA_VERSION, ...record } },
});

describe("server customData schema", () => {
  it("reads the widget record", () => {
    expect(readWidgetRecord(element({ widget: { kind: "pdf", assetId: "asset-1" } }))).toEqual({
      kind: "pdf",
      assetId: "asset-1",
    });
  });

  it("rejects an unknown widget kind or an empty asset id", () => {
    expect(
      readWidgetRecord(element({ widget: { kind: "unknown", assetId: "asset-1" } })),
    ).toBeNull();
    expect(readWidgetRecord(element({ widget: { kind: "pdf", assetId: "" } }))).toBeNull();
  });

  it("rejects an unknown schema version", () => {
    expect(
      readWidgetRecord({
        customData: {
          [NAMESPACE]: { schemaVersion: 999, widget: { kind: "pdf", assetId: "asset-1" } },
        },
      }),
    ).toBeNull();
  });

  it("ignores retired nodeState beside a widget record", () => {
    expect(
      readWidgetRecord(
        element({
          widget: { kind: "pdf", assetId: "asset-1" },
          nodeState: { pinned: true },
        }),
      ),
    ).toEqual({ kind: "pdf", assetId: "asset-1" });
  });
});
