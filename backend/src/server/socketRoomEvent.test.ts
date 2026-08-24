import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuthorizedRoomEvent } from "./socketRoomEvent";

const validPayload = { drawingId: "drawing-1" };

const setup = (limit = 1, windowMs = 1_000, access = true) => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const emit = vi.fn();
  const disconnect = vi.fn();
  const socket = {
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    emit,
    disconnect,
  } as any;
  const handle = vi.fn();
  registerAuthorizedRoomEvent({
    socket,
    event: "test-event",
    limit,
    windowMs,
    parse: (value) =>
      value && typeof value === "object" && (value as any).drawingId === "drawing-1"
        ? validPayload
        : null,
    requireAccess: vi.fn(async () => access),
    handle,
  });
  return { send: handlers.get("test-event")!, disconnect, emit, handle };
};

describe("authorized room event feedback", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("acknowledges every hard parse failure", async () => {
    const { send } = setup(10);
    const acknowledgements: any[] = [];

    await send({ drawingId: 42 }, (value: any) => acknowledgements.push(value));
    await send(null, (value: any) => acknowledgements.push(value));

    expect(acknowledgements).toEqual([
      {
        ok: false,
        error: {
          code: "invalid-request",
          message: "Invalid test-event payload",
        },
      },
      {
        ok: false,
        error: {
          code: "invalid-request",
          message: "Invalid test-event payload",
        },
      },
    ]);
  });

  it("acknowledges successful handling", async () => {
    const { send } = setup();
    const ack = vi.fn();

    await send(validPayload, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it("coalesces rate-limit feedback to one notice per limiting window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { send, emit } = setup();

    await send(validPayload);
    await send(validPayload);
    await send(validPayload);
    await send(validPayload);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("room-event-error", {
      event: "test-event",
      error: {
        code: "rate-limited",
        message: "test-event rate limit exceeded",
      },
    });

    vi.advanceTimersByTime(1_001);
    await send(validPayload);
    await send(validPayload);

    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a rate-limited command instead of making it time out", async () => {
    const { send } = setup();
    await send(validPayload, vi.fn());
    const ack = vi.fn();

    await send(validPayload, ack);

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: { code: "rate-limited", message: "test-event rate limit exceeded" },
    });
  });

  it("acknowledges a fresh access refusal", async () => {
    const { send } = setup(10, 1_000, false);
    const ack = vi.fn();

    await send(validPayload, ack);

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: { code: "access-denied", message: "test-event access denied" },
    });
  });

  it("acknowledges and logs an unexpected handler failure", async () => {
    const { send, handle } = setup(10);
    const failure = new Error("database offline");
    handle.mockRejectedValueOnce(failure);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ack = vi.fn();

    await send(validPayload, ack);

    const logged = stderrWrite.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Room event failed",
        event: "test-event",
        error: expect.objectContaining({ message: "database offline" }),
      }),
    );
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: { code: "internal-error", message: "test-event could not be completed" },
    });
    stderrWrite.mockRestore();
  });

  it("disconnects a malformed-packet flood after bounded feedback", async () => {
    const { send, disconnect, emit } = setup(20);

    for (let index = 0; index < 10; index += 1) {
      await send(null);
    }

    expect(emit).toHaveBeenCalledTimes(10);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith(true);
  });
  it("keeps a connection alive through a flood of ordinary access refusals", async () => {
    const { send, disconnect } = setup(40, 1_000, false);
    const acknowledgements: any[] = [];

    // Above HARD_FAILURE_LIMIT (10) on purpose: an ordinary refusal must never
    // reach the hard-failure counter, so crossing the threshold changes nothing.
    for (let index = 0; index < 12; index += 1) {
      await send(validPayload, (value: any) => acknowledgements.push(value));
    }

    expect(acknowledgements).toHaveLength(12);
    expect(acknowledgements.every((value) => value.ok === false)).toBe(true);
    expect(acknowledgements.every((value) => value.error.code === "access-denied")).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("keeps a connection alive through a flood of handler-reported business errors", async () => {
    const { send, disconnect, handle } = setup(40, 1_000);
    handle.mockResolvedValue({ error: { code: "board-locked", message: "board is locked" } });
    const acknowledgements: any[] = [];

    for (let index = 0; index < 12; index += 1) {
      await send(validPayload, (value: any) => acknowledgements.push(value));
    }

    expect(acknowledgements).toHaveLength(12);
    expect(acknowledgements.every((value) => value.error?.code === "board-locked")).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
