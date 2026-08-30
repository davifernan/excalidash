import { describe, expect, it } from "vitest";

import { NAMESPACE, SCHEMA_VERSION, readWidgetRecord as readOnServer } from "./customDataSchema";
import { readWidget as readOnFrontend } from "../../../frontend/src/integrations/excalidraw/customData";

/**
 * Cross-runtime behavioral proof for the widget slice of `customData.excalidash`
 * (NIL-637, second contract pulled out of #203/NIL-625, same mechanism as
 * document pagination's own contract test).
 *
 * Both sides now import the read path from `@excalidash/domain/customData`,
 * so today this test is largely redundant with the two unit-test files it
 * sits beside. That is the point, not a flaw: NIL-624's pagination
 * regression happened because the two copies were *believed* identical
 * ("byte-for-byte equivalent" said the comment) while nobody ran anything
 * that would notice if that stopped being true. This test is the thing
 * that notices -- it imports the real server module and the real frontend
 * module (not a domain-package unit test, which would only prove the
 * shared code works, not that both sides still call it the same way) and
 * fails the moment either side stops agreeing with the other, for whatever
 * reason: a future NIL-637-style extraction that goes wrong, a local
 * override reintroduced during a merge, or a frontend-only or
 * backend-only field added to one side's parser without adding it to the
 * shared module.
 */

const element = (record: Record<string, unknown>) => ({
  customData: { [NAMESPACE]: { schemaVersion: SCHEMA_VERSION, ...record } },
});

describe("customData widget cross-runtime contract", () => {
  it.each([
    {
      name: "a valid widget record",
      input: element({ widget: { kind: "pdf", assetId: "asset-1" } }),
      expected: { kind: "pdf", assetId: "asset-1" },
    },
    {
      name: "each known widget kind",
      input: element({ widget: { kind: "markdown", assetId: "asset-2" } }),
      expected: { kind: "markdown", assetId: "asset-2" },
    },
    {
      name: "an unknown widget kind",
      input: element({ widget: { kind: "spreadsheet", assetId: "asset-3" } }),
      expected: null,
    },
    {
      name: "an empty assetId",
      input: element({ widget: { kind: "text", assetId: "" } }),
      expected: null,
    },
    {
      name: "a missing assetId",
      input: element({ widget: { kind: "text" } }),
      expected: null,
    },
    {
      name: "a non-string assetId",
      input: element({ widget: { kind: "text", assetId: 42 } }),
      expected: null,
    },
    {
      name: "an unknown schema version",
      input: {
        customData: {
          [NAMESPACE]: { schemaVersion: 999, widget: { kind: "pdf", assetId: "asset-1" } },
        },
      },
      expected: null,
    },
    {
      name: "no customData at all",
      input: { id: "el-1" },
      expected: null,
    },
    {
      name: "foreign customData beside this namespace",
      input: {
        customData: {
          [NAMESPACE]: {
            schemaVersion: SCHEMA_VERSION,
            widget: { kind: "pdf", assetId: "asset-1" },
          },
          someOtherApp: { anything: true },
        },
      },
      expected: { kind: "pdf", assetId: "asset-1" },
    },
    {
      name: "retired nodeState beside a widget record",
      input: element({
        widget: { kind: "pdf", assetId: "asset-1" },
        nodeState: { pinned: true },
      }),
      expected: { kind: "pdf", assetId: "asset-1" },
    },
    {
      name: "a widget record beside frontend-only sticky data",
      input: element({
        widget: { kind: "pdf", assetId: "asset-1" },
        sticky: { color: "yellow", ink: "black", width: 200, height: 200 },
      }),
      expected: { kind: "pdf", assetId: "asset-1" },
    },
  ])("$name: server and frontend agree", ({ input, expected }) => {
    const serverResult = readOnServer(input);
    const frontendResult = readOnFrontend(input);

    expect(serverResult, "server result").toEqual(expected);
    expect(frontendResult, "frontend result").toEqual(expected);
    expect(frontendResult, "server and frontend must be byte-identical").toEqual(serverResult);
  });
});
