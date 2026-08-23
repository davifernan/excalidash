import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSceneUpdate,
  createFileCapability,
  createSceneCapability,
  readBoardSettings,
  summarise,
  type RawApi,
} from "./adapter";
import type { ElementId, FileId, NewElement } from "./types";

const element = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 30,
  height: 40,
  angle: 0,
  isDeleted: false,
  version: 7,
  versionNonce: 12345,
  text: "secret label",
  points: [[0, 0]],
  backgroundColor: "#fde68a",
  ...over,
});

const makeApi = (
  elements: Record<string, unknown>[] = [element()],
): RawApi & {
  updateScene: ReturnType<typeof vi.fn>;
} => {
  const api = {
    getSceneElements: () => elements.filter((e) => !e.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({ gridModeEnabled: true, gridSize: 20, viewBackgroundColor: "#fff" }),
    getFiles: () => ({ f1: { mimeType: "image/png", dataURL: "data:,", created: 1 } }),
    addFiles: vi.fn(),
    updateScene: vi.fn(),
    onChange: vi.fn(() => () => {}),
  };
  return api as unknown as RawApi & { updateScene: ReturnType<typeof vi.fn> };
};

const newElement = (id: string, over: Partial<NewElement> = {}): NewElement => ({
  id: id as ElementId,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...over,
});

describe("the read projection", () => {
  it("copies only the fields the contract names", () => {
    expect(Object.keys(summarise(element())).sort()).toEqual([
      "angle",
      "containerId",
      "customData",
      "frameId",
      "height",
      "id",
      "isDeleted",
      "link",
      "type",
      "width",
      "x",
      "y",
    ]);
  });

  it("does not carry the element's text out with it", () => {
    expect(JSON.stringify(summarise(element()))).not.toContain("secret label");
  });

  it("is a copy, so product code cannot write back through it", () => {
    const raw = element();
    const summary = summarise(raw) as unknown as Record<string, unknown>;
    summary.x = 999;
    expect(raw.x).toBe(10);
  });
});

describe("board settings", () => {
  it("reads the persistent half of the app state and nothing else", () => {
    const settings = readBoardSettings({
      gridModeEnabled: true,
      gridSize: 20,
      objectsSnapModeEnabled: true,
      viewBackgroundColor: "#eee",
      theme: "dark",
      scrollX: 500,
      zoom: { value: 2 },
    });
    expect(settings).toEqual({
      gridModeEnabled: true,
      gridSize: 20,
      gridStep: null,
      objectsSnapModeEnabled: true,
      viewBackgroundColor: "#eee",
      theme: "dark",
    });
  });
});

describe("building one editor update out of a list of operations", () => {
  it("inserts before the element it names, because a frame's children sit before it", () => {
    const scene = [element({ id: "a" }), element({ id: "frame" }), element({ id: "b" })];
    const update = buildSceneUpdate(scene, [
      { kind: "insert", elements: [newElement("note")], before: "frame" as ElementId },
    ]) as { elements: { id: string }[] };
    expect(update.elements.map((e) => e.id)).toEqual(["a", "note", "frame", "b"]);
  });

  it("appends when no anchor is named", () => {
    const update = buildSceneUpdate(
      [element({ id: "a" })],
      [{ kind: "insert", elements: [newElement("note")] }],
    ) as { elements: { id: string }[] };
    expect(update.elements.map((e) => e.id)).toEqual(["a", "note"]);
  });

  it("refuses an anchor that is not in the scene rather than appending quietly", () => {
    const update = buildSceneUpdate(
      [element({ id: "a" })],
      [{ kind: "insert", elements: [newElement("note")], before: "ghost" as ElementId }],
    ) as { ok: false; code: string };
    expect(update.ok).toBe(false);
    expect(update.code).toBe("invalid-state");
  });

  it("puts elements, selection and item defaults into ONE update", () => {
    const update = buildSceneUpdate(
      [element({ id: "frame" })],
      [
        { kind: "insert", elements: [newElement("note")], before: "frame" as ElementId },
        { kind: "select", ids: ["note" as ElementId] },
        { kind: "itemDefaults", fontSize: 20, strokeColor: "#422006" },
      ],
    ) as { elements: unknown[]; appState: Record<string, unknown> };

    expect(update.elements).toHaveLength(2);
    expect(update.appState.selectedElementIds).toEqual({ note: true });
    expect(update.appState.currentItemFontSize).toBe(20);
    expect(update.appState.currentItemStrokeColor).toBe("#422006");
  });

  it("does not send an elements key when no operation touched them", () => {
    const update = buildSceneUpdate([element()], [{ kind: "select", ids: [] }]) as Record<
      string,
      unknown
    >;
    expect("elements" in update).toBe(false);
  });

  it("marks a removal deleted rather than dropping it, so the peer learns of it", () => {
    const update = buildSceneUpdate(
      [element({ id: "a" }), element({ id: "b" })],
      [{ kind: "remove", ids: ["a" as ElementId] }],
    ) as { elements: { id: string; isDeleted: boolean }[] };
    expect(update.elements.map((e) => [e.id, e.isDeleted])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("translates the history capture the contract speaks into the editor's own", () => {
    const update = buildSceneUpdate([element()], [{ kind: "select", ids: [] }], "never") as Record<
      string,
      unknown
    >;
    expect(update.captureUpdate).toBe("NEVER");
  });
});

describe("the scene capability without an attached editor", () => {
  const capability = createSceneCapability(() => null);

  it("reports not-ready instead of throwing", () => {
    const result = capability.summaries();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-ready");
      expect(result.seam).toBe("scene.summaries");
    }
  });

  it("hands back a no-op unsubscribe rather than failing to subscribe", () => {
    expect(() => capability.subscribe(() => {})()).not.toThrow();
  });
});

describe("the scene capability with an editor", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
  });

  it("applies operations as a single updateScene call", () => {
    const capability = createSceneCapability(() => api);
    capability.apply([
      { kind: "select", ids: ["e1" as ElementId] },
      { kind: "itemDefaults", fontSize: 20 },
    ]);
    expect(api.updateScene).toHaveBeenCalledTimes(1);
  });

  it("hands out a document nothing can read fields off", () => {
    const capability = createSceneCapability(() => api);
    const result = capability.readDocument();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toContain("secret label");
    }
  });

  it("refuses a document it did not produce", () => {
    const capability = createSceneCapability(() => api);
    const foreign = {} as never;
    const result = capability.toPersisted(foreign);
    expect(result.ok).toBe(false);
  });
});

describe("the file capability", () => {
  it("reports only the files a confirmed baseline does not have", () => {
    const api = makeApi();
    const capability = createFileCapability(() => api);
    const none = capability.deltaAgainst(new Set());
    const all = capability.deltaAgainst(new Set(["f1" as FileId]));
    expect(none.ok && none.value.map((f) => f.id)).toEqual(["f1"]);
    expect(all.ok && all.value).toEqual([]);
  });
});
