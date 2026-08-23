import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdapter, toastError } = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../integrations/excalidraw", () => ({
  createExcalidrawAdapter: createAdapter,
}));

vi.mock("../integrations/excalidraw/domBridge", () => ({
  beginCanvasDrag: vi.fn(),
  pressEnterToEditLabel: vi.fn((_container, isEditing: () => boolean) => {
    isEditing();
    return Promise.resolve({ ok: true, value: undefined });
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError },
}));

import { StickyHandles } from "./StickyHandles";
import { StickyPreview } from "./StickyPreview";
import { beginArrowDrag } from "./stickyConnect";
import { DEFAULT_STICKY_COLOR, createStickyNote } from "./stickyNote";
import { insertStickyNote } from "./stickyPlacement";
import { useStickyHint } from "./useStickyHint";
import { useStickyKeys } from "./useStickyKeys";
import { useStickyNotes } from "./useStickyNotes";
import { useStickyUpkeep } from "./useStickyUpkeep";

const interactionState = {
  editingTextElementId: null,
  editingTextContainerId: null,
  creatingElementId: null,
  resizingElementId: null,
  activeTool: { type: "selection" as const },
};

const makeAdapter = (note = createStickyNote(200, 200)) => {
  const adapter = {
    scene: {
      apply: vi.fn().mockReturnValue({ ok: true, value: undefined }),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      summaries: vi.fn().mockReturnValue({ ok: true, value: [note] }),
      summaryById: vi.fn().mockReturnValue({ ok: true, value: note }),
    },
    selection: {
      read: vi
        .fn()
        .mockReturnValue({ ok: true, value: { selectedIds: [note.id], allSelected: false } }),
    },
    interaction: {
      onPointerDown: vi.fn().mockReturnValue(vi.fn()),
      read: vi.fn().mockReturnValue({ ok: true, value: interactionState }),
      setActiveTool: vi.fn().mockReturnValue({ ok: true, value: undefined }),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
    viewport: {
      read: vi.fn().mockReturnValue({
        ok: true,
        value: {
          zoom: 2,
          scrollX: 0,
          scrollY: 0,
          offsetLeft: 0,
          offsetTop: 0,
          width: 800,
          height: 600,
        },
      }),
      toScene: vi.fn().mockReturnValue({ ok: true, value: { x: 200, y: 200 } }),
    },
  };
  createAdapter.mockReturnValue(adapter);
  return adapter;
};

describe("sticky consumers at the Excalidraw boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads preview zoom through the viewport capability", () => {
    const adapter = makeAdapter();
    const container = document.createElement("div");

    render(
      <StickyPreview
        excalidrawAPI={{ current: {} }}
        containerRef={{ current: container }}
        color={DEFAULT_STICKY_COLOR}
      />,
    );
    fireEvent.pointerMove(container, { clientX: 100, clientY: 100 });

    expect(adapter.viewport.read).toHaveBeenCalled();
    expect(screen.getByTestId("sticky-preview")).toHaveStyle({ width: "400px", height: "400px" });
  });

  it("keeps the unzoomed preview fallback while the editor is not ready", () => {
    const adapter = makeAdapter();
    adapter.viewport.read.mockReturnValue({
      ok: false,
      code: "not-ready",
      seam: "viewport.read",
    });
    const container = document.createElement("div");

    render(
      <StickyPreview
        excalidrawAPI={{ current: null }}
        containerRef={{ current: container }}
        color={DEFAULT_STICKY_COLOR}
      />,
    );
    fireEvent.pointerMove(container, { clientX: 100, clientY: 100 });

    expect(screen.getByTestId("sticky-preview")).toHaveStyle({ width: "200px", height: "200px" });
  });

  it("resolves the sticky hint through scene, selection, and interaction capabilities", () => {
    const adapter = makeAdapter();
    const container = document.createElement("div");

    renderHook(() =>
      useStickyHint({
        excalidrawAPI: { current: {} },
        containerRef: { current: container },
        canEdit: true,
        ready: true,
      }),
    );

    expect(adapter.selection.read).toHaveBeenCalled();
    expect(adapter.interaction.read).toHaveBeenCalled();
    expect(adapter.scene.summaryById).toHaveBeenCalled();
    expect(container.dataset.stickySelection).toBe("true");
  });

  it("arms the sticky tool through the interaction capability", () => {
    const adapter = makeAdapter();

    const { result } = renderHook(() =>
      useStickyNotes({
        excalidrawAPI: { current: {} },
        containerRef: { current: document.createElement("div") },
        canEdit: true,
      }),
    );

    act(() => result.current.arm());

    expect(adapter.interaction.setActiveTool).toHaveBeenCalledWith({
      type: "custom",
      customType: "sticky",
    });
    expect(adapter.interaction.onPointerDown).toHaveBeenCalled();
  });

  it("keeps a failed sticky-tool handoff visible and unarmed", () => {
    const adapter = makeAdapter();
    adapter.interaction.setActiveTool.mockReturnValue({
      ok: false,
      code: "not-ready",
      seam: "interaction.setActiveTool",
    });
    const { result } = renderHook(() =>
      useStickyNotes({
        excalidrawAPI: { current: {} },
        containerRef: { current: document.createElement("div") },
        canEdit: true,
      }),
    );

    act(() => result.current.arm());

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't change the sticky-note tool. Please try again.",
    );
    expect(result.current.armed).toBe(false);
  });

  it("finds the selected source note through capabilities before handling Tab", () => {
    const note = createStickyNote(200, 200);
    const adapter = makeAdapter(note);
    const container = document.createElement("div");
    const api = {
      getAppState: vi.fn().mockReturnValue({
        editingTextElement: null,
        selectedElementIds: { [note.id]: true },
      }),
      getSceneElements: vi.fn().mockReturnValue([note]),
      getSceneElementsIncludingDeleted: vi.fn().mockReturnValue([note]),
      updateScene: vi.fn(),
    };

    renderHook(() =>
      useStickyKeys({
        excalidrawAPI: { current: api },
        containerRef: { current: container },
        canEdit: true,
      }),
    );
    fireEvent.keyDown(container, { key: "Tab" });

    expect(adapter.selection.read).toHaveBeenCalled();
    expect(adapter.interaction.read).toHaveBeenCalled();
    expect(adapter.scene.summaryById).toHaveBeenCalledWith(note.id);
  });

  it("lays out handles from capability projections", () => {
    const adapter = makeAdapter();
    const container = document.createElement("div");

    render(
      <StickyHandles
        excalidrawAPI={{ current: { getAppState: () => ({ draggingElement: null }) } }}
        containerRef={{ current: container }}
        canEdit
      />,
    );

    expect(adapter.scene.summaries).toHaveBeenCalled();
    expect(adapter.selection.read).toHaveBeenCalled();
    expect(adapter.interaction.read).toHaveBeenCalled();
    expect(adapter.viewport.read).toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("arms arrow drags through the assembled interaction capability", () => {
    const adapter = makeAdapter();

    beginArrowDrag({}, document.createElement("div"), {
      clientX: 10,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(adapter.interaction.setActiveTool).toHaveBeenCalledWith({
      type: "builtin",
      name: "arrow",
    });
  });

  it("makes a failed arrow-tool handoff visible", () => {
    const adapter = makeAdapter();
    adapter.interaction.setActiveTool.mockReturnValue({
      ok: false,
      code: "not-ready",
      seam: "interaction.setActiveTool",
    });

    beginArrowDrag({}, document.createElement("div"), {
      clientX: 10,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(toastError).toHaveBeenCalledWith("Couldn't start the arrow. Please try again.");
  });

  it("checks placed-label editing through the interaction capability", () => {
    const note = createStickyNote(200, 200);
    const adapter = makeAdapter(note);
    adapter.interaction.read.mockReturnValue({
      ok: true,
      value: { ...interactionState, editingTextContainerId: note.id },
    });
    const api = {
      getAppState: vi.fn().mockReturnValue({ editingTextElement: { containerId: note.id } }),
      getSceneElementsIncludingDeleted: vi.fn().mockReturnValue([]),
      updateScene: vi.fn(),
    };
    const frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    insertStickyNote(api, document.createElement("div"), note, DEFAULT_STICKY_COLOR);

    expect(adapter.interaction.read).toHaveBeenCalled();
    frame.mockRestore();
  });

  it("watches editor closure through the interaction capability", async () => {
    const adapter = makeAdapter();
    const api = {
      getAppState: vi.fn().mockReturnValue({
        editingTextElement: null,
        resizingElement: null,
        newElement: null,
      }),
      getSceneElementsIncludingDeleted: vi.fn().mockReturnValue([{}]),
      updateScene: vi.fn(),
    };
    const frames: FrameRequestCallback[] = [];
    const frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { result } = renderHook(() =>
      useStickyUpkeep({ excalidrawAPI: { current: api }, canEdit: true }),
    );

    act(() => {
      result.current.onSceneChange([{}], { editingTextElement: { id: "label" } });
    });
    await act(async () => Promise.resolve());
    act(() => frames.shift()?.(0));

    expect(adapter.interaction.read).toHaveBeenCalled();
    frame.mockRestore();
  });
});
