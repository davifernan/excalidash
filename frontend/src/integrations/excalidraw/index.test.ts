import { describe, expect, it, vi } from "vitest";

import { createExcalidrawAdapter } from "./index";

const handle = () => ({
  getSceneElements: () => [],
  getSceneElementsIncludingDeleted: () => [],
  getAppState: () => ({ selectedElementIds: { a: true } }),
  getFiles: () => ({}),
  addFiles: vi.fn(),
  updateScene: vi.fn(),
  onChange: vi.fn(() => () => {}),
  onPointerDown: vi.fn(() => () => {}),
  setActiveTool: vi.fn(),
  updateLibrary: vi.fn(),
  onUserFollow: vi.fn(() => () => {}),
  onScrollChange: vi.fn(() => () => {}),
});

describe("the assembled adapter", () => {
  it("offers every capability the contract names", () => {
    const adapter = createExcalidrawAdapter({
      api: () => null,
      container: () => null,
      canEdit: () => true,
    });
    expect(Object.keys(adapter).sort()).toEqual([
      "boardSettings",
      "collaboration",
      "compatibility",
      "export",
      "files",
      "history",
      "interaction",
      "scene",
      "selection",
      "text",
      "ui",
      "viewport",
      "widgets",
    ]);
  });

  it("survives the gap between mounting and being handed the editor", () => {
    // Excalidraw calls excalidrawAPI after its first render, so there is always
    // a window where the host exists and the handle does not. That window is a
    // normal state, not a defect.
    const adapter = createExcalidrawAdapter({
      api: () => null,
      container: () => null,
      canEdit: () => true,
    });
    const result = adapter.scene.summaries();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not-ready");
  });

  it("reads the handle late, so a capability taken early still works later", () => {
    let api: unknown = null;
    const adapter = createExcalidrawAdapter({
      api: () => api,
      container: () => null,
      canEdit: () => true,
    });
    const scene = adapter.scene;

    expect(scene.summaries().ok).toBe(false);
    api = handle();
    expect(scene.summaries().ok).toBe(true);
  });

  it("reports the selection the editor holds", () => {
    const adapter = createExcalidrawAdapter({
      api: handle,
      container: () => null,
      canEdit: () => true,
    });
    const result = adapter.selection.read();
    expect(result.ok && result.value.selectedIds).toEqual(["a"]);
  });

  describe("selection.anchorAt", () => {
    const handleWithElements = (elements: Record<string, unknown>[]) => () => ({
      ...handle(),
      getSceneElements: () => elements,
      getSceneElementsIncludingDeleted: () => elements,
    });

    it("anchors to the element under the point", () => {
      const adapter = createExcalidrawAdapter({
        api: handleWithElements([
          { id: "rect-1", type: "rectangle", x: 0, y: 0, width: 100, height: 50, angle: 0 },
        ]),
        container: () => null,
        canEdit: () => true,
      });
      const result = adapter.selection.anchorAt({ x: 50, y: 25 });
      expect(result.ok && result.value).toBe("rect-1");
    });

    it("succeeds with a null element when the point hits nothing", () => {
      // A click on empty canvas is a normal, expected outcome -- a pure point
      // anchor -- not a capability failure. Callers (useCommentPlacement.ts)
      // only show an error toast when `ok` is false.
      const adapter = createExcalidrawAdapter({
        api: handleWithElements([
          { id: "rect-1", type: "rectangle", x: 0, y: 0, width: 100, height: 50, angle: 0 },
        ]),
        container: () => null,
        canEdit: () => true,
      });
      const result = adapter.selection.anchorAt({ x: 500, y: 500 });
      expect(result).toEqual({ ok: true, value: null });
    });

    it("picks the topmost of two overlapping elements", () => {
      const adapter = createExcalidrawAdapter({
        api: handleWithElements([
          { id: "back", type: "rectangle", x: 0, y: 0, width: 100, height: 100, angle: 0 },
          { id: "front", type: "rectangle", x: 20, y: 20, width: 40, height: 40, angle: 0 },
        ]),
        container: () => null,
        canEdit: () => true,
      });
      const result = adapter.selection.anchorAt({ x: 40, y: 40 });
      expect(result.ok && result.value).toBe("front");
    });

    it("accounts for rotation, not just the unrotated bounding box", () => {
      // An 80x80 square centered at (100,100), rotated 45deg into a diamond.
      // (61,61) sits well inside the UNROTATED axis-aligned box [60,140]^2,
      // but a 45deg rotation swings the diamond's actual edges away from that
      // corner -- only rotation-aware math gets this right.
      const adapter = createExcalidrawAdapter({
        api: handleWithElements([
          {
            id: "diamond",
            type: "rectangle",
            x: 60,
            y: 60,
            width: 80,
            height: 80,
            angle: Math.PI / 4,
          },
        ]),
        container: () => null,
        canEdit: () => true,
      });
      const missUnrotatedCorner = adapter.selection.anchorAt({ x: 61, y: 61 });
      expect(missUnrotatedCorner).toEqual({ ok: true, value: null });
      const hitCenter = adapter.selection.anchorAt({ x: 100, y: 100 });
      expect(hitCenter.ok && hitCenter.value).toBe("diamond");
    });

    it("anchors to a shape inside a frame, not the frame itself, even when the frame is later in z-order", () => {
      // A click on content inside a frame must anchor to that content, not
      // the frame it happens to sit in -- the frame is a container, and
      // clicking into it is not the same as clicking on an element within it.
      // The frame is deliberately listed AFTER (on top of, by plain z-order)
      // its content here: a naive "topmost wins" scan with no frame-awareness
      // would hit the frame first and never reach the shape underneath.
      const adapter = createExcalidrawAdapter({
        api: handleWithElements([
          { id: "shape-1", type: "rectangle", x: 50, y: 50, width: 40, height: 40, angle: 0 },
          { id: "frame-1", type: "frame", x: 0, y: 0, width: 200, height: 200, angle: 0 },
        ]),
        container: () => null,
        canEdit: () => true,
      });
      const onShape = adapter.selection.anchorAt({ x: 70, y: 70 });
      expect(onShape.ok && onShape.value).toBe("shape-1");

      const onEmptyFrameSpace = adapter.selection.anchorAt({ x: 150, y: 150 });
      expect(onEmptyFrameSpace.ok && onEmptyFrameSpace.value).toBe("frame-1");
    });

    it("fails with not-ready when the editor has not mounted yet", () => {
      const adapter = createExcalidrawAdapter({
        api: () => null,
        container: () => null,
        canEdit: () => true,
      });
      const result = adapter.selection.anchorAt({ x: 0, y: 0 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not-ready");
    });
  });

  it("reports every seam as missing when there is no editor at all", () => {
    const adapter = createExcalidrawAdapter({
      api: () => null,
      container: () => null,
      canEdit: () => true,
    });
    const report = adapter.compatibility.verifySeams();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.missing).toContain("api:updateScene");
      expect(report.value.checked).toBeGreaterThan(20);
    }
  });

  it("finds nothing missing when handed a complete handle", () => {
    const adapter = createExcalidrawAdapter({
      api: handle,
      container: () => null,
      canEdit: () => true,
    });
    const report = adapter.compatibility.verifySeams();
    expect(report.ok && report.value.missing).toEqual([]);
  });

  it("reports the version it is running against", () => {
    const adapter = createExcalidrawAdapter({
      api: handle,
      container: () => null,
      canEdit: () => true,
    });
    expect(adapter.compatibility.packageVersion()).toBe("0.18.1");
  });
});

describe("the migrated capability wiring", () => {
  const labelledElements = [
    {
      id: "note-1",
      type: "rectangle",
      boundElements: [{ id: "label-1", type: "text" }],
    },
    {
      id: "label-1",
      type: "text",
      containerId: "note-1",
      text: "Wrapped label",
      originalText: "Original label",
      fontSize: 20,
    },
  ];

  const labelledAdapter = () => {
    const api = {
      ...handle(),
      getSceneElements: () => labelledElements,
      getSceneElementsIncludingDeleted: () => labelledElements,
      getAppState: () => ({
        selectedElementIds: {},
        editingTextElement: labelledElements[1],
      }),
    };
    return {
      api,
      adapter: createExcalidrawAdapter({
        api: () => api,
        container: () => null,
        canEdit: () => true,
      }),
    };
  };

  it("reads a container's bound label without leaking the raw element", () => {
    const { adapter } = labelledAdapter();

    const result = adapter.text.readLabel("note-1" as never);

    expect(result).toEqual({
      ok: true,
      value: {
        id: "label-1",
        containerId: "note-1",
        text: "Wrapped label",
        originalText: "Original label",
        fontSize: 20,
      },
    });
    expect(result.ok && result.value).not.toBe(labelledElements[1]);
  });

  it("reports the container whose label is currently being typed", () => {
    const { adapter } = labelledAdapter();

    expect(adapter.text.labelsBeingTyped()).toEqual({ ok: true, value: ["note-1"] });
  });

  it("builds a font-size patch for the bound text element", () => {
    const { adapter } = labelledAdapter();

    expect(adapter.text.setLabelFontSize("note-1" as never, 16)).toEqual({
      ok: true,
      value: { kind: "patch", id: "label-1", changes: { fontSize: 16 } },
    });
  });

  it("creates an exportable document through the assembled adapter", () => {
    const { adapter } = labelledAdapter();
    const document = adapter.scene.readDocument();
    expect(document.ok).toBe(true);
    if (!document.ok) return;

    const result = adapter.export.exportableDocument(document.value);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).not.toBe(document.value);
  });

  it("validates SVG export documents through the assembled adapter", async () => {
    const { adapter } = labelledAdapter();

    const result = await adapter.export.toSvg({ document: {} as never });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-state");
      expect(result.seam).toBe("export.toSvg");
    }
  });

  it("previews a historical document and restores the live one", async () => {
    let elements: readonly unknown[] = [{ id: "historical", type: "rectangle" }];
    let appState: Record<string, unknown> = {
      selectedElementIds: { historical: true },
      collaborators: new Map([["historical-peer", {}]]),
    };
    const api = {
      ...handle(),
      getSceneElements: () => elements,
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => appState,
      getFiles: () => ({}),
    };
    const adapter = createExcalidrawAdapter({
      api: () => api,
      container: () => null,
      canEdit: () => true,
    });
    const historical = adapter.scene.readDocument();
    expect(historical.ok).toBe(true);
    if (!historical.ok) return;
    elements = [{ id: "live", type: "rectangle" }];
    const liveCollaborators = new Map([["live-peer", {}]]);
    appState = { selectedElementIds: { live: true }, collaborators: liveCollaborators };

    const preview = await adapter.history.beginPreview(historical.value);

    expect(preview.ok).toBe(true);
    expect(api.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [{ id: "historical", type: "rectangle" }],
        appState: expect.objectContaining({ collaborators: undefined }),
        captureUpdate: "NEVER",
      }),
    );
    if (!preview.ok) return;
    await preview.value.restore();
    expect(api.updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elements: [{ id: "live", type: "rectangle" }],
        appState: {
          selectedElementIds: { live: true },
          collaborators: liveCollaborators,
        },
        captureUpdate: "NEVER",
      }),
    );
  });
});

describe("the library seam", () => {
  /**
   * Without the wiring in index.ts the capability still compiles: `updateLibrary`
   * and `readLibraryItems` are optional on UiApi, so an unwired host reports
   * `unsupported` at runtime and the caller falls back to the raw handle. That
   * fallback is the boundary hole this layer exists to close, so the wiring
   * itself needs a guard.
   */
  it("imports through the host instead of reporting unsupported", async () => {
    const api = { ...handle(), getAppState: () => ({ libraryItems: [{ id: "one" }] }) };
    const adapter = createExcalidrawAdapter({
      api: () => api as never,
      container: () => null,
      canEdit: () => true,
    });

    const result = await adapter.ui.importLibrary([{ id: "one" }] as never, { merge: true });

    expect(result.ok).toBe(true);
    expect(api.updateLibrary).toHaveBeenCalledTimes(1);
    expect(result.ok && result.value).toEqual([{ id: "one" }]);
  });
});
