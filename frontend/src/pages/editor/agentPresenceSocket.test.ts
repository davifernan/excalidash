import { afterEach, describe, expect, it, vi } from "vitest";
import { bindBoardAgentPresence } from "./socketCollaborators";
import {
  BOARD_AGENT_FOCUS_FINISHED_EVENT,
  BOARD_AGENT_FOCUS_STARTED_EVENT,
  BOARD_AGENT_PRESENCE_EVENT,
  BOARD_AGENT_SETTLE_MS,
  type BoardAgentPresenceWire,
} from "./agentPresenceState";

class AgentPresenceSocketDouble {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: (payload: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  receive(event: string, payload: unknown) {
    this.handlers.get(event)?.forEach((handler) => handler(payload));
  }
}

const entry = (overrides: Partial<BoardAgentPresenceWire> = {}): BoardAgentPresenceWire => ({
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

describe("Agent Presence on the collaboration socket", () => {
  afterEach(() => vi.useRealTimers());

  it("tracks three named agents through the existing socket and clears on reset", () => {
    vi.useFakeTimers();
    const socket = new AgentPresenceSocketDouble();
    const changes: any[] = [];
    const binding = bindBoardAgentPresence({
      socket: socket as any,
      onChange: (value) => changes.push(value),
    });
    socket.receive(BOARD_AGENT_PRESENCE_EVENT, [
      entry(),
      entry({ agentId: "run-b", runId: "run-b", displayName: "Design", targetIds: ["frame-b"] }),
      entry({ agentId: "run-c", runId: "run-c", displayName: "QA", targetIds: ["frame-c"] }),
    ]);
    expect(changes.at(-1).map((value: any) => value.displayName)).toEqual([
      "Research",
      "Design",
      "QA",
    ]);
    binding.reset();
    expect(changes.at(-1)).toEqual([]);
    binding.dispose();
  });

  it("settles a finished read rather than flashing it away", () => {
    vi.useFakeTimers();
    const socket = new AgentPresenceSocketDouble();
    const changes: any[] = [];
    const binding = bindBoardAgentPresence({
      socket: socket as any,
      onChange: (value) => changes.push(value),
      tickIntervalMs: 100,
    });
    socket.receive(BOARD_AGENT_FOCUS_STARTED_EVENT, {
      ...entry(),
      occurredAt: new Date().toISOString(),
    });
    socket.receive(BOARD_AGENT_FOCUS_FINISHED_EVENT, {
      ...entry({ focusActive: false }),
      occurredAt: new Date().toISOString(),
    });
    expect(changes.at(-1)[0].activeTargetIds).toEqual(["frame-a"]);
    vi.advanceTimersByTime(BOARD_AGENT_SETTLE_MS + 200);
    expect(changes.at(-1)[0]).toMatchObject({
      activeTargetIds: [],
      trailTargetIds: ["frame-a"],
    });
    binding.dispose();
  });
});
