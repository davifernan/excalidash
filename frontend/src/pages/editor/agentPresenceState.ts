export const BOARD_AGENT_FOCUS_STARTED_EVENT = "agent.focus.started";
export const BOARD_AGENT_FOCUS_FINISHED_EVENT = "agent.focus.finished";
export const BOARD_AGENT_RUNTIME_EVENT = "agent.runtime.updated";
export const BOARD_AGENT_PRESENCE_EVENT = "agent.presence.updated";

export const BOARD_AGENT_SETTLE_MS = 1_200;
export const BOARD_AGENT_TRAIL_MS = 1_500;
export const BOARD_AGENT_CRASH_MS = 8_000;

export type BoardAgentPresenceWire = {
  agentId: string;
  runId: string;
  drawingId: string;
  revisionId: string;
  displayName: string;
  color: string;
  status: "working" | "idle" | "blocked" | "done" | "unknown";
  targetIds: readonly string[];
  focusActive: boolean;
  visibility: "private" | "drawing";
};

export type BoardAgentFocusWire = Omit<
  BoardAgentPresenceWire,
  "color" | "status" | "focusActive"
> & {
  phase: "started" | "finished";
  occurredAt: string;
};

export type BoardAgentRuntimeWire = Omit<
  BoardAgentPresenceWire,
  "color" | "targetIds" | "focusActive"
> & { occurredAt: string };

type BoardAgentTrail = { targetIds: readonly string[]; startedAt: number };

type BoardAgentVisualRun = BoardAgentPresenceWire & {
  activeTargetIds: readonly string[];
  settleAt: number | null;
  trail: BoardAgentTrail | null;
  lastEventAt: number;
};

export type BoardAgentVisualSnapshot = Omit<BoardAgentPresenceWire, "targetIds" | "focusActive"> & {
  activeTargetIds: readonly string[];
  trailTargetIds: readonly string[];
  trailOpacity: number;
};

const sameTargets = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const metadataFromWire = (
  wire: BoardAgentPresenceWire,
): Omit<BoardAgentVisualRun, "activeTargetIds" | "settleAt" | "trail" | "lastEventAt"> => ({
  agentId: wire.agentId,
  runId: wire.runId,
  drawingId: wire.drawingId,
  revisionId: wire.revisionId,
  displayName: wire.displayName,
  color: wire.color,
  status: wire.status,
  targetIds: wire.targetIds,
  focusActive: wire.focusActive,
  visibility: wire.visibility,
});

export class BoardAgentPresenceState {
  private readonly runs = new Map<string, BoardAgentVisualRun>();

  replace(entries: readonly BoardAgentPresenceWire[], now: number): void {
    const incoming = new Set(entries.map((entry) => entry.runId));
    for (const runId of this.runs.keys()) {
      if (!incoming.has(runId)) this.runs.delete(runId);
    }
    for (const entry of entries) {
      this.applyPresence(entry, now);
    }
  }

  applyPresence(entry: BoardAgentPresenceWire, now: number): void {
    const existing = this.runs.get(entry.runId);
    const base: BoardAgentVisualRun = {
      ...metadataFromWire(entry),
      activeTargetIds: existing?.activeTargetIds ?? [],
      settleAt: existing?.settleAt ?? null,
      trail: existing?.trail ?? null,
      lastEventAt: now,
    };
    this.runs.set(entry.runId, base);
    this.applyFocus(
      {
        ...entry,
        phase: entry.focusActive ? "started" : "finished",
        occurredAt: "",
      },
      now,
    );
  }

  applyFocus(event: BoardAgentFocusWire, now: number): void {
    const existing = this.runs.get(event.runId);
    if (event.phase === "finished") {
      if (!existing) return;
      this.runs.set(event.runId, {
        ...existing,
        revisionId: event.revisionId,
        displayName: event.displayName,
        visibility: event.visibility,
        focusActive: false,
        settleAt: now + BOARD_AGENT_SETTLE_MS,
        lastEventAt: now,
      });
      return;
    }

    const nextTargets = [...new Set(event.targetIds)];
    const moved = existing && !sameTargets(existing.activeTargetIds, nextTargets);
    this.runs.set(event.runId, {
      ...(existing ?? {
        agentId: event.agentId,
        runId: event.runId,
        drawingId: event.drawingId,
        color: "#7c3aed",
        status: "working" as const,
        targetIds: nextTargets,
        trail: null,
      }),
      revisionId: event.revisionId,
      displayName: event.displayName,
      visibility: event.visibility,
      targetIds: nextTargets,
      focusActive: true,
      activeTargetIds: nextTargets,
      settleAt: null,
      trail:
        moved && existing.activeTargetIds.length > 0
          ? { targetIds: existing.activeTargetIds, startedAt: now }
          : (existing?.trail ?? null),
      lastEventAt: now,
    });
  }

  applyRuntime(event: BoardAgentRuntimeWire, now: number): void {
    if (event.status === "done") {
      this.runs.delete(event.runId);
      return;
    }
    const existing = this.runs.get(event.runId);
    if (!existing) return;
    this.runs.set(event.runId, {
      ...existing,
      revisionId: event.revisionId,
      displayName: event.displayName || existing.displayName,
      visibility: event.visibility,
      status: event.status,
      lastEventAt: now,
    });
  }

  tick(now: number): void {
    for (const [runId, state] of this.runs) {
      if (now - state.lastEventAt > BOARD_AGENT_CRASH_MS) {
        this.runs.delete(runId);
        continue;
      }
      let next = state;
      if (state.settleAt !== null && now >= state.settleAt) {
        next = {
          ...state,
          activeTargetIds: [],
          settleAt: null,
          trail: state.activeTargetIds.length
            ? { targetIds: state.activeTargetIds, startedAt: state.settleAt }
            : state.trail,
        };
      }
      if (next.trail && now - next.trail.startedAt > BOARD_AGENT_TRAIL_MS) {
        next = { ...next, trail: null };
      }
      this.runs.set(runId, next);
    }
  }

  snapshot(now: number): readonly BoardAgentVisualSnapshot[] {
    return Array.from(this.runs.values())
      .sort((left, right) => left.runId.localeCompare(right.runId))
      .map(
        ({
          targetIds: _targetIds,
          focusActive: _focusActive,
          settleAt: _settleAt,
          trail,
          lastEventAt: _lastEventAt,
          ...state
        }) => ({
          ...state,
          trailTargetIds: trail?.targetIds ?? [],
          trailOpacity: trail ? Math.max(0, 1 - (now - trail.startedAt) / BOARD_AGENT_TRAIL_MS) : 0,
        }),
      );
  }

  clear(): void {
    this.runs.clear();
  }
}
