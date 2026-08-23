import { exportToSvg } from "@excalidraw/excalidraw";
import { describe, expect, it, vi } from "vitest";

import { createExportCapability, substituteWidgets } from "./export";
import { withExcalidashData } from "./customData";
import type { SceneDocument } from "./types";
import { WIDGET_LINK } from "./widgets";

// Only the renderer is faked. `convertToExcalidrawElements` is what turns the
// substitute's `label` shorthand into a real bound text element -- the very
// thing NIL-277 is about -- so mocking it away would leave these tests
// asserting against a stand-in instead of the behaviour.
vi.mock("@excalidraw/excalidraw", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exportToSvg: vi.fn(),
}));

const widget = (id: string, kind: "pdf" | "markdown" = "pdf") => ({
  id,
  type: "embeddable",
  link: WIDGET_LINK,
  x: 10,
  y: 20,
  width: 480,
  height: 680,
  angle: 0,
  customData: withExcalidashData({}, { widget: { kind, assetId: `asset-${id}` } }),
});

const rectangle = (id: string) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0,
});

describe("substituting widgets for export (NIL-277)", () => {
  it("replaces a widget, which would otherwise export as an empty box with a URL", () => {
    const { elements, substituted } = substituteWidgets([widget("w1")]);
    expect(substituted).toBe(1);
    expect(elements[0].type).toBe("rectangle");
    expect(elements[0].link).toBeFalsy();
  });

  it("splices in the bound text as well, or the substitute is a box with no words", () => {
    const { elements } = substituteWidgets([widget("w1")]);
    const text = elements.find((element) => element.type === "text");
    expect(text).toBeDefined();
    expect((text as unknown as { containerId: unknown }).containerId).toBe(elements[0].id);
  });

  it("keeps the widget's place and size, so the export still reads as the board", () => {
    const { elements } = substituteWidgets([widget("w1")]);
    expect(elements[0]).toMatchObject({ x: 10, y: 20, width: 480, height: 680 });
  });

  it("says which kind of document was there", () => {
    const { elements } = substituteWidgets([widget("w1", "markdown")]);
    const text = elements.find((element) => element.type === "text");
    expect((text as unknown as { text: string }).text).toBe("MARKDOWN document");
  });

  it("leaves everything that is not a widget exactly as it was", () => {
    const rect = rectangle("r1");
    const { elements, substituted } = substituteWidgets([rect]);
    expect(substituted).toBe(0);
    expect(elements[0]).toBe(rect);
  });

  it("leaves an embeddable that is not ours alone", () => {
    const video = { ...widget("v1"), link: "https://youtube.com/watch?v=1" };
    const { elements, substituted } = substituteWidgets([video]);
    expect(substituted).toBe(0);
    expect(elements[0]).toBe(video);
  });

  it("does not touch the elements it was handed, because the board is live", () => {
    const original = widget("w1");
    const snapshot = JSON.stringify(original);
    substituteWidgets([original]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("handles a board with several widgets and other elements between them", () => {
    const { elements, substituted } = substituteWidgets([
      rectangle("r1"),
      widget("w1"),
      rectangle("r2"),
      widget("w2", "markdown"),
    ]);
    expect(substituted).toBe(2);
    // Each substitute contributes a container and its bound text, so the two
    // widgets become four elements between the two untouched rectangles.
    expect(elements.filter((element) => element.type === "text")).toHaveLength(2);
    expect(elements.map((element) => element.id)).toContain("r1");
    expect(elements.map((element) => element.id)).toContain("r2");
    expect(elements.map((element) => element.id)).toContain("w1-export");
    expect(elements.map((element) => element.id)).toContain("w2-export");
  });
});

describe("the export capability", () => {
  type Contents = {
    elements: readonly Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  };

  const documents = new WeakMap<object, Contents>();
  const seal = (contents: Contents): SceneDocument => {
    const document = {} as SceneDocument;
    documents.set(document as object, contents);
    return document;
  };
  const read = (document: SceneDocument) => documents.get(document as object) ?? null;

  it("returns a new document containing renderable widget substitutes", () => {
    const capability = createExportCapability(read, seal);
    const document = seal({ elements: [widget("w1")], appState: {}, files: {} });

    const result = capability.exportableDocument(document);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(document);
    expect(read(result.value)?.elements[0]).toMatchObject({
      id: "w1-export",
      type: "rectangle",
    });
  });

  it("renders the substituted document with the requested SVG options", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    vi.mocked(exportToSvg).mockResolvedValueOnce(svg as never);
    const capability = createExportCapability(read, seal);
    const source = seal({
      elements: [widget("w1")],
      appState: { viewBackgroundColor: "#fff" },
      files: { file1: { id: "file1" } },
    });

    const result = await capability.toSvg({
      document: source,
      padding: 24,
      withBackground: false,
      includeMetadata: true,
    });

    expect(result).toEqual({ ok: true, value: svg });
    expect(exportToSvg).toHaveBeenCalledWith({
      // Rectangle AND bound text. A substitute that is only a rectangle is the
      // empty box NIL-277 exists to remove, and the `label` shorthand only turns
      // into a real text element once `convertToExcalidrawElements` has run.
      elements: expect.arrayContaining([
        expect.objectContaining({ id: "w1-export", type: "rectangle" }),
        expect.objectContaining({ type: "text", containerId: "w1-export" }),
      ]),
      appState: {
        viewBackgroundColor: "#fff",
        exportBackground: false,
        exportEmbedScene: true,
      },
      files: { file1: { id: "file1" } },
      exportPadding: 24,
    });
  });
});
