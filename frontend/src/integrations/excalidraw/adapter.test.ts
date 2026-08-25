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
      "boundElements",
      "containerId",
      "customData",
      "endBinding",
      "frameId",
      "height",
      "id",
      "isDeleted",
      "link",
      "name",
      "opacity",
      "startBinding",
      "type",
      "width",
      "x",
      "y",
    ]);
  });

  it("does not carry the element's text out with it", () => {
    expect(JSON.stringify(summarise(element()))).not.toContain("secret label");
  });

  it("reads a frame's name, and reports null for every other element", () => {
    expect(summarise(element()).name).toBeNull();
    expect(summarise(element({ type: "frame", name: "1. Ideas" })).name).toBe("1. Ideas");
  });

  it("is a copy, so product code cannot write back through it", () => {
    const raw = element();
    const summary = summarise(raw) as unknown as Record<string, unknown>;
    summary.x = 999;
    expect(raw.x).toBe(10);
  });

  it("reads boundElements, or null when the element carries none (NIL-575)", () => {
    expect(summarise(element()).boundElements).toBeNull();
    expect(
      summarise(element({ boundElements: [{ id: "arrow-1", type: "arrow" }] })).boundElements,
    ).toEqual([{ id: "arrow-1", type: "arrow" }]);
  });

  it("drops a boundElements entry of an unrecognised type rather than passing it through blind", () => {
    expect(
      summarise(
        element({
          boundElements: [
            { id: "arrow-1", type: "arrow" },
            { id: "x", type: "frame" },
          ],
        }),
      ).boundElements,
    ).toEqual([{ id: "arrow-1", type: "arrow" }]);
  });

  /**
   * Counter-test: break the enforcement by reverting `summarise` to the
   * pre-NIL-575 version that never reads `boundElements` at all -- a
   * plausible regression if a future edit to this function drops the field
   * again. Copied here rather than `git checkout --`, per NIL-570/575/576's
   * evidence rule.
   */
  it("regression guard: a summarise without boundElements support would fail the read test above", () => {
    const summariseWithoutBoundElements = (raw: Record<string, unknown>) => {
      const { boundElements: _dropped, ...rest } = summarise(raw) as unknown as Record<
        string,
        unknown
      >;
      return rest;
    };
    const broken = summariseWithoutBoundElements(
      element({ boundElements: [{ id: "arrow-1", type: "arrow" }] }),
    );
    expect(broken.boundElements).toBeUndefined();
    expect(
      summarise(element({ boundElements: [{ id: "arrow-1", type: "arrow" }] })).boundElements,
    ).toEqual([{ id: "arrow-1", type: "arrow" }]);
  });

  it("reads an arrow's own startBinding/endBinding, or null per end when unbound (NIL-593)", () => {
    expect(summarise(element()).startBinding).toBeNull();
    expect(summarise(element()).endBinding).toBeNull();
    const arrow = summarise(
      element({
        type: "arrow",
        startBinding: { elementId: "box-a", focus: 0, gap: 4 },
        endBinding: { elementId: "box-b", focus: 0, gap: 4 },
      }),
    );
    expect(arrow.startBinding).toEqual({ elementId: "box-a" });
    expect(arrow.endBinding).toEqual({ elementId: "box-b" });
  });

  it("reports null for a binding missing or malformed, rather than passing a partial object through", () => {
    expect(summarise(element({ startBinding: null })).startBinding).toBeNull();
    expect(summarise(element({ startBinding: {} })).startBinding).toBeNull();
    expect(summarise(element({ startBinding: { elementId: 42 } })).startBinding).toBeNull();
  });

  /**
   * Counter-test: break the enforcement by reverting `summarise` to a
   * version that never reads `startBinding`/`endBinding` at all -- exactly
   * the state this file was in before NIL-593, and a plausible regression
   * if a future edit drops the fields again. Copied here, not
   * `git checkout --`'d, per NIL-570/575/576's own evidence rule.
   */
  it("regression guard: a summarise without binding support would fail the read test above", () => {
    const summariseWithoutBindings = (raw: Record<string, unknown>) => {
      const {
        startBinding: _s,
        endBinding: _e,
        ...rest
      } = summarise(raw) as unknown as Record<string, unknown>;
      return rest;
    };
    const broken = summariseWithoutBindings(
      element({ type: "arrow", startBinding: { elementId: "box-a" } }),
    );
    expect(broken.startBinding).toBeUndefined();
    expect(
      summarise(element({ type: "arrow", startBinding: { elementId: "box-a" } })).startBinding,
    ).toEqual({ elementId: "box-a" });
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

  it("keeps every field the caller set, not only the ones the contract names", () => {
    // A sticky note arrives here fully built: angle, seed, roundness, font
    // size, the bound-text bookkeeping. An earlier version of this whitelisted
    // eleven fields and dropped the rest, so the note went in as a bare
    // rectangle and the label editor had nothing to open -- green in every unit
    // test, because they only asserted the fields the whitelist kept.
    const rich = {
      ...newElement("note"),
      angle: 0.5,
      seed: 12345,
      roundness: { type: 3 },
      fontSize: 20,
      boundElements: [{ id: "t1", type: "text" }],
      strokeWidth: 2,
    } as unknown as NewElement;

    const update = buildSceneUpdate([], [{ kind: "insert", elements: [rich] }]) as {
      elements: Record<string, unknown>[];
    };

    expect(update.elements[0]).toMatchObject({
      angle: 0.5,
      seed: 12345,
      roundness: { type: 3 },
      fontSize: 20,
      boundElements: [{ id: "t1", type: "text" }],
      strokeWidth: 2,
    });
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

describe("a patch op and the bookkeeping the merge reads", () => {
  /**
   * The existing test for `setLabelFontSize` checked the shape of the op it
   * returns, never the element after `scene.apply`. A raw spread produces an
   * element that looks changed to a human and unchanged to `reconcileElements`,
   * which decides a merge on version, versionNonce and updated.
   */
  it("bumps the version bookkeeping rather than spreading over it", () => {
    const element = { id: "e1", type: "text", fontSize: 16, version: 3, versionNonce: 111 };
    let written: any = null;
    const api = {
      getSceneElements: () => [element],
      getSceneElementsIncludingDeleted: () => [element],
      getAppState: () => ({}),
      updateScene: (scene: any) => {
        written = scene;
      },
    };
    const scene = createSceneCapability(() => api as never);

    const result = scene.apply([{ kind: "patch", id: "e1" as never, changes: { fontSize: 28 } }]);

    expect(result.ok).toBe(true);
    const patched = written.elements.find((e: any) => e.id === "e1");
    expect(patched.fontSize).toBe(28);
    expect(patched.version).toBeGreaterThan(3);
    expect(patched.versionNonce).not.toBe(111);
  });

  /**
   * NIL-575's write side: a shape's `boundElements` patches through like any
   * other field, and round-trips back out through `summarise` unchanged --
   * the two-way binding contract (arrow knows the shape via
   * `start`/`endBinding`, shape knows the arrow via `boundElements`) is only
   * as good as this write actually landing.
   */
  it("patches boundElements, and summarise reads the result back", () => {
    const element = { id: "e1", type: "rectangle", x: 0, y: 0, boundElements: null };
    let written: any = null;
    const api = {
      getSceneElements: () => [element],
      getSceneElementsIncludingDeleted: () => [element],
      getAppState: () => ({}),
      updateScene: (scene: any) => {
        written = scene;
      },
    };
    const scene = createSceneCapability(() => api as never);

    const result = scene.apply([
      {
        kind: "patch",
        id: "e1" as never,
        changes: { boundElements: [{ id: "arrow-1" as never, type: "arrow" }] },
      },
    ]);

    expect(result.ok).toBe(true);
    const patched = written.elements.find((e: any) => e.id === "e1");
    expect(summarise(patched).boundElements).toEqual([{ id: "arrow-1", type: "arrow" }]);
  });
});
