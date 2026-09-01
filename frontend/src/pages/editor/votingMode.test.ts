import { describe, expect, it, vi } from "vitest";
import {
  bindVotingMode,
  parseVotingSnapshot,
  VOTING_CAST_EVENT,
  VOTING_COMMAND_EVENT,
  VOTING_STATE_EVENT,
} from "./votingMode";

const makeSocket = () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => handlers.set(event, handler)),
    off: vi.fn(),
    trigger: (event: string, payload: unknown) => handlers.get(event)?.(payload),
  };
};

describe("parseVotingSnapshot", () => {
  it("accepts idle", () => {
    expect(parseVotingSnapshot({ drawingId: "d1", status: "idle" }, "d1")).toMatchObject({
      status: "idle",
      tally: null,
    });
  });

  it("rejects a snapshot for another drawing", () => {
    expect(parseVotingSnapshot({ drawingId: "d2", status: "idle" }, "d1")).toBeNull();
  });

  it("accepts an open round with no tally at all -- not zeroed, absent", () => {
    const snapshot = parseVotingSnapshot(
      {
        drawingId: "d1",
        status: "open",
        roundId: "r1",
        prompt: "Ship it?",
        options: [
          { id: "0", label: "Yes" },
          { id: "1", label: "No" },
        ],
        maxSelections: 1,
      },
      "d1",
    );
    expect(snapshot?.status).toBe("open");
    expect(snapshot?.tally).toBeNull();
    // Absent on the wire stays absent here.
    expect(snapshot?.participantCount).toBeNull();
  });

  it("keeps the ballot count of a live round, while still refusing its tally", () => {
    // The two used to be gated together, so a count sent during a live round
    // was discarded on arrival -- carried the whole way and dropped by the
    // reader. The tally is still refused while open; the count is not.
    const snapshot = parseVotingSnapshot(
      {
        drawingId: "d1",
        status: "open",
        roundId: "r1",
        prompt: "Ship it?",
        options: [
          { id: "0", label: "Yes" },
          { id: "1", label: "No" },
        ],
        maxSelections: 1,
        participantCount: 2,
        tally: { "0": 2 },
      },
      "d1",
    );

    expect(snapshot?.participantCount).toBe(2);
    expect(snapshot?.tally).toBeNull();
  });

  it("rejects a revealed round without a tally", () => {
    expect(
      parseVotingSnapshot(
        {
          drawingId: "d1",
          status: "revealed",
          roundId: "r1",
          prompt: "Ship it?",
          options: [{ id: "0", label: "Yes" }],
          maxSelections: 1,
        },
        "d1",
      ),
    ).toBeNull();
  });

  it("accepts a revealed round with its tally", () => {
    const snapshot = parseVotingSnapshot(
      {
        drawingId: "d1",
        status: "revealed",
        roundId: "r1",
        prompt: "Ship it?",
        options: [{ id: "0", label: "Yes" }],
        maxSelections: 1,
        tally: { "0": 3 },
        participantCount: 3,
      },
      "d1",
    );
    expect(snapshot).toMatchObject({ tally: { "0": 3 }, participantCount: 3 });
  });
});

describe("bindVotingMode", () => {
  it("parses and forwards incoming voting-state events", () => {
    const socket = makeSocket();
    const onStateChange = vi.fn();
    bindVotingMode({ socket: socket as never, drawingId: "d1", onStateChange });

    socket.trigger(VOTING_STATE_EVENT, { drawingId: "d1", status: "idle" });

    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ status: "idle" }));
  });

  it("sends open/reveal/close as acked commands", async () => {
    const socket = makeSocket();
    (socket.emit as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _payload: unknown, ack?: (value: unknown) => void) => ack?.({ ok: true }),
    );
    const controller = bindVotingMode({
      socket: socket as never,
      drawingId: "d1",
      onStateChange: vi.fn(),
    });

    await expect(controller.open("Ship it?", ["Yes", "No"], 1)).resolves.toEqual({ ok: true });
    expect(socket.emit).toHaveBeenCalledWith(
      VOTING_COMMAND_EVENT,
      {
        drawingId: "d1",
        action: "open",
        prompt: "Ship it?",
        options: ["Yes", "No"],
        maxSelections: 1,
      },
      expect.any(Function),
    );
    await expect(controller.reveal()).resolves.toEqual({ ok: true });
    await expect(controller.close()).resolves.toEqual({ ok: true });
  });

  it("sends a cast with the round id and option ids", async () => {
    const socket = makeSocket();
    (socket.emit as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _payload: unknown, ack?: (value: unknown) => void) => ack?.({ ok: true }),
    );
    const controller = bindVotingMode({
      socket: socket as never,
      drawingId: "d1",
      onStateChange: vi.fn(),
    });

    await controller.cast("round-1", ["0", "1"]);

    expect(socket.emit).toHaveBeenCalledWith(
      VOTING_CAST_EVENT,
      { drawingId: "d1", roundId: "round-1", optionIds: ["0", "1"] },
      expect.any(Function),
    );
  });

  it("reset reports idle without touching the socket", () => {
    const socket = makeSocket();
    const onStateChange = vi.fn();
    const controller = bindVotingMode({ socket: socket as never, drawingId: "d1", onStateChange });
    controller.reset();
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ status: "idle" }));
  });
});
