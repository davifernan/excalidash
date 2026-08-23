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

  it("says which capabilities are not built yet, rather than pretending", () => {
    const adapter = createExcalidrawAdapter({
      api: handle,
      container: () => null,
      canEdit: () => true,
    });
    const notYet = adapter.text.readLabel("x" as never);
    expect(notYet.ok).toBe(false);
    if (!notYet.ok) {
      expect(notYet.code).toBe("unsupported");
      expect(notYet.detail).toContain("sticky migration");
    }
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
