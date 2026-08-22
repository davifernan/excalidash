import { describe, expect, it, vi } from "vitest";
import { bindSocketDrawingName, parseDrawingNameUpdate } from "./drawingName";

describe("live drawing names", () => {
  it("accepts only a bounded name for the current drawing", () => {
    expect(
      parseDrawingNameUpdate(
        { drawingId: "drawing-1", name: "Live roadmap", revision: 2 },
        "drawing-1",
      ),
    ).toEqual({ drawingId: "drawing-1", name: "Live roadmap", revision: 2 });
    expect(
      parseDrawingNameUpdate({ drawingId: "drawing-2", name: "Wrong room" }, "drawing-1"),
    ).toBeNull();
    expect(
      parseDrawingNameUpdate({ drawingId: "drawing-1", name: "x".repeat(256) }, "drawing-1"),
    ).toBeNull();
    expect(
      parseDrawingNameUpdate({ drawingId: "drawing-1", name: "No revision" }, "drawing-1"),
    ).toBeNull();
  });

  it("updates from the server event and removes its listener on disposal", () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const socket = {
      on: vi.fn((event: string, handler: (value: unknown) => void) => handlers.set(event, handler)),
      off: vi.fn(),
    };
    const onChange = vi.fn();
    const binding = bindSocketDrawingName({
      socket: socket as any,
      drawingId: "drawing-1",
      onChange,
    });

    handlers.get("drawing-name-update")?.({
      drawingId: "drawing-1",
      name: "Live roadmap",
      revision: 1,
    });
    expect(onChange).toHaveBeenCalledWith("Live roadmap");

    binding.dispose();
    expect(socket.off).toHaveBeenCalledWith("drawing-name-update", expect.any(Function));
  });

  it("does not let a delayed join snapshot overwrite a newer broadcast", () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const socket = {
      on: vi.fn((event: string, handler: (value: unknown) => void) => handlers.set(event, handler)),
      off: vi.fn(),
    };
    const onChange = vi.fn();
    bindSocketDrawingName({ socket: socket as any, drawingId: "drawing-1", onChange });

    handlers.get("drawing-name-update")?.({
      drawingId: "drawing-1",
      name: "New broadcast",
      revision: 2,
    });
    handlers.get("drawing-name-update")?.({
      drawingId: "drawing-1",
      name: "Stale join snapshot",
      revision: 1,
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("New broadcast");
  });

  it("still applies a join snapshot when no broadcast preceded it", () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const socket = {
      on: vi.fn((event: string, handler: (value: unknown) => void) => handlers.set(event, handler)),
      off: vi.fn(),
    };
    const onChange = vi.fn();
    bindSocketDrawingName({ socket: socket as any, drawingId: "drawing-1", onChange });

    handlers.get("drawing-name-update")?.({
      drawingId: "drawing-1",
      name: "Join snapshot",
      revision: 1,
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("Join snapshot");
  });
});
