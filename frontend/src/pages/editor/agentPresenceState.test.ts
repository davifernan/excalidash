import { describe, expect, it } from "vitest";
import {
  BOARD_AGENT_CRASH_MS,
  BOARD_AGENT_SETTLE_MS,
  BoardAgentPresenceState,
  type BoardAgentFocusWire,
  type BoardAgentPresenceWire,
} from "./agentPresenceState";

const presence = (overrides: Partial<BoardAgentPresenceWire> = {}): BoardAgentPresenceWire => ({
  agentId: "run-a",
  runId: "run-a",
  drawingId: "drawing-1",
  revisionId: "revision-17",
  displayName: "Research",
  color: "#7c3aed",
  status: "working",
  targetIds: ["frame-a"],
  focusActive: true,
  visibility: "drawing",
  ...overrides,
});

const focus = (overrides: Partial<BoardAgentFocusWire> = {}): BoardAgentFocusWire => ({
  ...presence(),
  phase: "started",
  occurredAt: "1970-01-01T00:00:00.000Z",
  ...overrides,
});

describe("BoardAgentPresenceState", () => {
  it("keeps fast finished/started bursts continuously visible", () => {
    const state = new BoardAgentPresenceState();
    state.replace([presence()], 0);
    for (let index = 0; index < 20; index += 1) {
      const at = index * 50;
      state.applyFocus(focus({ phase: "finished" }), at);
      state.applyFocus(focus(), at + 5);
      state.tick(at + 5);
      expect(state.snapshot(at + 5)[0].activeTargetIds).toEqual(["frame-a"]);
    }
  });

  it("turns a completed target into one short trail", () => {
    const state = new BoardAgentPresenceState();
    state.replace([presence()], 0);
    state.applyFocus(focus({ phase: "finished" }), 10);
    state.tick(10 + BOARD_AGENT_SETTLE_MS + 1);
    expect(state.snapshot(10 + BOARD_AGENT_SETTLE_MS + 1)[0]).toMatchObject({
      activeTargetIds: [],
      trailTargetIds: ["frame-a"],
    });
  });

  it("tracks three named agents independently", () => {
    const state = new BoardAgentPresenceState();
    state.replace(
      [
        presence(),
        presence({
          agentId: "run-b",
          runId: "run-b",
          displayName: "Design",
          targetIds: ["frame-b"],
        }),
        presence({ agentId: "run-c", runId: "run-c", displayName: "QA", targetIds: ["frame-c"] }),
      ],
      0,
    );
    expect(
      state.snapshot(0).map(({ displayName, activeTargetIds }) => [displayName, activeTargetIds]),
    ).toEqual([
      ["Research", ["frame-a"]],
      ["Design", ["frame-b"]],
      ["QA", ["frame-c"]],
    ]);
  });

  it("drops a crashed run instead of claiming stale activity", () => {
    const state = new BoardAgentPresenceState();
    state.replace([presence()], 0);
    state.tick(BOARD_AGENT_CRASH_MS + 1);
    expect(state.snapshot(BOARD_AGENT_CRASH_MS + 1)).toEqual([]);
  });

  it("treats each server snapshot as authoritative for this viewer", () => {
    const state = new BoardAgentPresenceState();
    state.replace([presence()], 0);
    state.replace([], 10);
    expect(state.snapshot(10)).toEqual([]);
  });
});
