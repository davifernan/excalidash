import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("../integrations/excalidraw/domBridge", () => ({
  beginCanvasDrag: vi.fn(),
  findFloatingToolbarObstacleElements: vi.fn(() => []),
  findToastStackElement: vi.fn(() => null),
  observeStructure: vi.fn(() => () => {}),
  pressEnterToEditLabel: vi.fn((_container, isEditing: () => boolean) => {
    isEditing();
    return Promise.resolve({ ok: true, value: undefined });
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError },
}));

import { StickyHandles } from "./StickyHandles";
import { StickyPalette } from "./StickyPalette";
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
      // The upkeep reads the scene fresh at the moment it writes, rather than
      // normalising the list its callback was handed one change ago.
      readDocument: vi.fn().mockReturnValue({ ok: false, code: "not-ready" }),
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
      subscribeScroll: vi.fn().mockReturnValue(vi.fn()),
    },
  };
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
        containerRef={{ current: container }}
        color={DEFAULT_STICKY_COLOR}
        viewport={adapter.viewport as any}
      />,
    );
    fireEvent.pointerMove(container, { clientX: 100, clientY: 100 });

    expect(adapter.viewport.read).toHaveBeenCalled();
    expect(screen.getByTestId("sticky-preview")).toHaveStyle({ width: "400px", height: "400px" });
  });

  it("shows the colour toolbar for one selected note and recolours through scene.apply", () => {
    const adapter = makeAdapter();
    const container = document.createElement("div");
    document.body.append(container);
    const onPick = vi.fn();

    render(
      <StickyPalette
        containerRef={{ current: container }}
        interaction={adapter.interaction as any}
        scene={adapter.scene as any}
        selection={adapter.selection as any}
        viewport={adapter.viewport as any}
        ready
        onPick={onPick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    expect(adapter.scene.apply).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          kind: "patch",
          changes: expect.objectContaining({
            backgroundColor: "#bfdbfe",
            strokeColor: "#93c5fd",
          }),
        }),
      ],
      { capture: "immediate" },
    );
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "blue" }));
  });

  it("shows no colour toolbar for a multi-selection", () => {
    const adapter = makeAdapter();
    adapter.selection.read.mockReturnValue({
      ok: true,
      value: { selectedIds: ["note", "other"], allSelected: false },
    });
    const container = document.createElement("div");

    render(
      <StickyPalette
        containerRef={{ current: container }}
        interaction={adapter.interaction as any}
        scene={adapter.scene as any}
        selection={adapter.selection as any}
        viewport={adapter.viewport as any}
        ready
        onPick={vi.fn()}
      />,
    );

    expect(screen.queryByRole("toolbar", { name: "Note colour" })).toBeNull();
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
        containerRef={{ current: container }}
        color={DEFAULT_STICKY_COLOR}
        viewport={adapter.viewport as any}
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
        containerRef: { current: container },
        canEdit: true,
        interaction: adapter.interaction as any,
        ready: true,
        scene: adapter.scene as any,
        selection: adapter.selection as any,
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
        containerRef: { current: document.createElement("div") },
        canEdit: true,
        elements: () => [],
        interaction: adapter.interaction as any,
        scene: adapter.scene as any,
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
        containerRef: { current: document.createElement("div") },
        canEdit: true,
        elements: () => [],
        interaction: adapter.interaction as any,
        scene: adapter.scene as any,
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

    renderHook(() =>
      useStickyKeys({
        containerRef: { current: container },
        canEdit: true,
        elements: () => [note],
        interaction: adapter.interaction as any,
        scene: adapter.scene as any,
        selection: adapter.selection as any,
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
        containerRef={{ current: container }}
        canEdit
        interaction={adapter.interaction as any}
        isDragging={() => false}
        scene={adapter.scene as any}
        selection={adapter.selection as any}
        viewport={adapter.viewport as any}
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

    beginArrowDrag(adapter.interaction as any, document.createElement("div"), {
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

    beginArrowDrag(adapter.interaction as any, document.createElement("div"), {
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
    const frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    insertStickyNote(
      adapter.scene as any,
      document.createElement("div"),
      note,
      DEFAULT_STICKY_COLOR,
      adapter.interaction as any,
    );

    expect(adapter.interaction.read).toHaveBeenCalled();
    frame.mockRestore();
  });

  it("does not start label editing when the scene rejects a sticky insertion", () => {
    const adapter = makeAdapter();
    adapter.scene.apply.mockReturnValue({
      ok: false,
      code: "editor-changed",
      seam: "scene.apply",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");

    insertStickyNote(
      adapter.scene as any,
      document.createElement("div"),
      createStickyNote(200, 200),
      DEFAULT_STICKY_COLOR,
      adapter.interaction as any,
    );

    const logged = JSON.parse(error.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      message: "[Sticky] Failed to insert note",
      result: { ok: false, seam: "scene.apply" },
    });
    expect(frame).not.toHaveBeenCalled();
    frame.mockRestore();
    error.mockRestore();
  });

  it("watches editor closure through the interaction capability", async () => {
    const adapter = makeAdapter();
    const frames: FrameRequestCallback[] = [];
    const frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { result } = renderHook(() =>
      useStickyUpkeep({
        canEdit: true,
        interaction: adapter.interaction as any,
        scene: adapter.scene as any,
      }),
    );

    act(() => {
      result.current.onSceneChange([{}], { editingTextElement: { id: "label" } });
    });
    await act(async () => Promise.resolve());
    act(() => frames.shift()?.(0));

    expect(adapter.interaction.read).toHaveBeenCalled();
    frame.mockRestore();
  });

  it("reports a rejected sticky upkeep write", async () => {
    const note = { ...createStickyNote(200, 200), height: 300 };
    const adapter = makeAdapter(note);
    adapter.scene.apply.mockReturnValue({
      ok: false,
      code: "editor-changed",
      seam: "scene.apply",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      useStickyUpkeep({
        canEdit: true,
        interaction: adapter.interaction as any,
        scene: adapter.scene as any,
      }),
    );

    act(() => result.current.onSceneChange([note], {}));
    await act(async () => Promise.resolve());

    const logged = JSON.parse(error.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      message: "[Sticky] Failed to normalise notes",
      result: { ok: false, seam: "scene.apply" },
    });
    error.mockRestore();
  });
});
