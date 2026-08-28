import { describe, expect, it, vi } from "vitest";

import {
  createInteractionCapability,
  readActiveTool,
  readArrowStyle,
  readInteraction,
  toEditorTool,
} from "./interaction";

describe("the tool, as a shape rather than a string", () => {
  it("keeps the sticky tool's custom type, which a bare string cannot say", () => {
    expect(readActiveTool({ type: "custom", customType: "sticky" })).toEqual({
      type: "custom",
      customType: "sticky",
    });
  });

  it("round-trips a custom tool back to the editor unchanged", () => {
    expect(toEditorTool({ type: "custom", customType: "sticky" })).toEqual({
      type: "custom",
      customType: "sticky",
    });
  });

  it("distinguishes selection from a drawing tool", () => {
    expect(readActiveTool({ type: "selection" })).toEqual({ type: "selection" });
    expect(readActiveTool({ type: "arrow" })).toEqual({ type: "builtin", name: "arrow" });
  });

  it("falls back to selection rather than to an unusable shape", () => {
    expect(readActiveTool(null)).toEqual({ type: "selection" });
    expect(readActiveTool({ type: "custom" })).toEqual({ type: "builtin", name: "custom" });
  });
});

describe("reading what the editor is doing", () => {
  it("reports which element is being edited, not merely that one is", () => {
    const state = readInteraction({
      editingTextElement: { id: "t1", containerId: "c1" },
    });
    expect(state.editingTextElementId).toBe("t1");
    expect(state.editingTextContainerId).toBe("c1");
  });

  it("reports which element is being created and which resized", () => {
    const state = readInteraction({
      newElement: { id: "n1" },
      resizingElement: { id: "r1" },
    });
    expect(state.creatingElementId).toBe("n1");
    expect(state.resizingElementId).toBe("r1");
  });

  it("reports nothing in flight as null rather than as a false-y guess", () => {
    const state = readInteraction({});
    expect(state.editingTextElementId).toBeNull();
    expect(state.creatingElementId).toBeNull();
    expect(state.resizingElementId).toBeNull();
  });
});

describe("reading the current native arrow defaults", () => {
  it("keeps every style field an ordinary arrow receives", () => {
    expect(
      readArrowStyle({
        currentItemStrokeColor: "#ff006e",
        currentItemStrokeWidth: 4,
        currentItemStrokeStyle: "dashed",
        currentItemRoundness: { type: 2 },
        currentItemStartArrowhead: "triangle",
        currentItemEndArrowhead: "arrow",
        currentItemArrowType: "round",
      }),
    ).toEqual({
      strokeColor: "#ff006e",
      strokeWidth: 4,
      strokeStyle: "dashed",
      roundness: { type: 2 },
      startArrowhead: "triangle",
      endArrowhead: "arrow",
      elbowed: false,
    });
  });

  it("reports not-ready through the capability rather than exposing the raw handle", () => {
    const result = createInteractionCapability(() => null).readArrowStyle();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.seam).toBe("interaction.readArrowStyle");
  });
});

describe("arming a tool and waiting for it", () => {
  const makeApi = (becomesActiveAfterMs: number | null) => {
    let active: Record<string, unknown> = { type: "selection" };
    return {
      getAppState: () => ({ activeTool: active }),
      onChange: vi.fn(() => () => {}),
      setActiveTool: vi.fn((tool: Record<string, unknown>) => {
        if (becomesActiveAfterMs === null) return;
        setTimeout(() => {
          active = tool;
        }, becomesActiveAfterMs);
      }),
    };
  };

  it("resolves once the editor really holds the tool", async () => {
    const api = makeApi(80);
    const result = await createInteractionCapability(() => api).setActiveToolSettled({
      type: "custom",
      customType: "sticky",
    });
    expect(result.ok).toBe(true);
  });

  it("reports editor-changed when the tool never becomes active", async () => {
    const api = makeApi(null);
    const result = await createInteractionCapability(() => api).setActiveToolSettled(
      { type: "custom", customType: "sticky" },
      { timeoutMs: 80 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("editor-changed");
  });

  it("does not report success merely because setActiveTool returned", async () => {
    // The tool is set through React state; a pointer event landing before that
    // commits is read as a selection drag instead.
    const api = makeApi(null);
    const capability = createInteractionCapability(() => api);
    expect(capability.setActiveTool({ type: "selection" }).ok).toBe(true);
    const settled = await capability.setActiveToolSettled(
      { type: "custom", customType: "sticky" },
      { timeoutMs: 60 },
    );
    expect(settled.ok).toBe(false);
  });
});

describe("pointer down", () => {
  it("reports the scene point and the tool that was held", () => {
    const listeners: ((tool: unknown, state: unknown) => void)[] = [];
    const api = {
      getAppState: () => ({}),
      onChange: vi.fn(() => () => {}),
      setActiveTool: vi.fn(),
      onPointerDown: (listener: (tool: unknown, state: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    };
    const seen = vi.fn();
    createInteractionCapability(() => api).onPointerDown(seen);
    listeners[0]({ type: "custom", customType: "sticky" }, { origin: { x: 5, y: 6 } });

    expect(seen).toHaveBeenCalledWith({ x: 5, y: 6 }, { type: "custom", customType: "sticky" });
  });

  it("ignores an event with no usable origin rather than reporting (0,0)", () => {
    const listeners: ((tool: unknown, state: unknown) => void)[] = [];
    const api = {
      getAppState: () => ({}),
      onChange: vi.fn(() => () => {}),
      setActiveTool: vi.fn(),
      onPointerDown: (listener: (tool: unknown, state: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    };
    const seen = vi.fn();
    createInteractionCapability(() => api).onPointerDown(seen);
    listeners[0]({ type: "selection" }, {});
    expect(seen).not.toHaveBeenCalled();
  });
});
