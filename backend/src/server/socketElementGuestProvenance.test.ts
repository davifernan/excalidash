import { describe, expect, it, vi } from "vitest";
import { FakeIo, FakeSocket, room } from "../__tests__/socketTestDoubles";
import { registerCoreRoomEvents } from "./socketCoreRoomEvents";

const payload = {
  drawingId: "drawing-1",
  elements: [{ id: "note-1" }],
};

const register = (
  socket: FakeSocket,
  recordElementProvenance: (input: {
    drawingId: string;
    elements: unknown[];
    elementOrder?: string[];
  }) => Promise<void>,
  requireAccess = vi.fn().mockResolvedValue("edit"),
) => {
  registerCoreRoomEvents({
    socket: socket as any,
    getPresence: () => null,
    requireAccess,
    setActive: () => false,
    emitPresence: () => undefined,
    allowActivity: () => true,
    allowCursorMove: () => true,
    allowElementUpdate: () => true,
    authorizeFileDelta: async () => true,
    recordElementProvenance,
  });
};

describe("socket element provenance", () => {
  it("records an admitted mutation before broadcasting it", async () => {
    const io = new FakeIo();
    const socket = new FakeSocket("guest", io.emissions);
    const record = vi.fn(async () => {
      expect(io.emissions.filter((entry) => entry.event === "element-update")).toHaveLength(0);
    });
    register(socket, record);

    await socket.trigger("element-update", payload);

    expect(record).toHaveBeenCalledWith({
      drawingId: "drawing-1",
      elements: [{ id: "note-1" }],
      elementOrder: undefined,
    });
    expect(io.emissions).toEqual([
      expect.objectContaining({ scope: room("drawing-1"), event: "element-update" }),
    ]);
  });

  it("does not record a refused mutation", async () => {
    const io = new FakeIo();
    const socket = new FakeSocket("guest", io.emissions);
    const record = vi.fn().mockResolvedValue(undefined);
    register(socket, record, vi.fn().mockResolvedValue(null));

    await socket.trigger("element-update", payload);

    expect(record).not.toHaveBeenCalled();
    expect(io.emissions.filter((entry) => entry.event === "element-update")).toHaveLength(0);
  });
});
