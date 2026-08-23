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
