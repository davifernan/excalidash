import type {
  BoardAgentFocusEvent,
  BoardAgentRunAudience,
  BoardAgentRuntimePresenceEvent,
} from "../agent/presence";

/**
 * Who is connected to which board, right now.
 *
 * This lives in its own module so that the HTTP side can read it without
 * importing the socket server — and so the socket server keeps writing to one
 * place instead of two. Nothing here is persisted: presence is a fact about
 * open connections, and when the process restarts there is nothing to remember.
 */
export type PresenceKind = "owner" | "member" | "guest";

export type PresenceEntry = {
  presenceId: string;
  accountId: string | null;
  name: string;
  initials: string;
  color: string;
  kind: PresenceKind;
  isActive: boolean;
  selectedElementIds: Record<string, true>;
  allSelected?: boolean;
  /** API-key sockets collaborate with data but do not receive social UI. */
  receivesAgentEvents?: boolean;
};

/**
 * What a presence looks like to the people sharing the board.
 *
 * The account id stays behind: everyone in the room gets this, and a share link
 * puts anonymous visitors in the room too. An account id is a handle to a real
 * row, so handing it out lets a visitor recognise the same person on any other
 * board they are ever given a link to. Nothing on the client reads it — the one
 * place that needs to match presence against a member list does it with a
 * scoped subject key instead (see authz/subjectKey).
 */
export type PublicPresenceEntry = Omit<
  PresenceEntry,
  "accountId" | "selectedElementIds" | "allSelected" | "receivesAgentEvents"
>;

export const toPublicPresence = ({
  accountId: _accountId,
  selectedElementIds: _selectedElementIds,
  allSelected: _allSelected,
  receivesAgentEvents: _receivesAgentEvents,
  ...rest
}: PresenceEntry): PublicPresenceEntry => rest;

export type BoardAgentPresenceEntry = {
  agentId: string;
  runId: string;
  drawingId: string;
  revisionId: string;
  displayName: string;
  color: string;
  status: "working" | "idle" | "blocked" | "done" | "unknown";
  targetIds: readonly string[];
  focusActive: boolean;
  audience: BoardAgentRunAudience;
  lastEventAt: number;
};

export type PublicBoardAgentPresenceEntry = Omit<
  BoardAgentPresenceEntry,
  "audience" | "lastEventAt"
> & { visibility: BoardAgentRunAudience["kind"] };

export type StaleBoardAgentPresence = {
  drawingId: string;
  audience: BoardAgentRunAudience;
};

export type SelectionSnapshotEntry = { presenceId: string } & (
  { selectedElementIds: string[] } | { allSelected: true }
);

export type SelectionSnapshot = {
  drawingId: string;
  selections: SelectionSnapshotEntry[];
};

export type PresenceSummaryMember = {
  accountId: string;
  name: string;
  initials: string;
  color: string;
  kind: Exclude<PresenceKind, "guest">;
};

export type PresenceSummary = {
  members: PresenceSummaryMember[];
  guestCount: number;
};

export class PresenceRegistry {
  private readonly byDrawing = new Map<string, Map<string, PresenceEntry>>();
  private readonly agentsByDrawing = new Map<string, Map<string, BoardAgentPresenceEntry>>();

  join(drawingId: string, entry: PresenceEntry): void {
    const entries = this.byDrawing.get(drawingId) || new Map<string, PresenceEntry>();
    entries.set(entry.presenceId, entry);
    this.byDrawing.set(drawingId, entries);
  }

  leave(drawingId: string, presenceId: string): void {
    const entries = this.byDrawing.get(drawingId);
    if (!entries) return;
    entries.delete(presenceId);
    if (entries.size === 0) this.byDrawing.delete(drawingId);
  }

  get(drawingId: string, presenceId: string): PresenceEntry | null {
    return this.byDrawing.get(drawingId)?.get(presenceId) || null;
  }

  setActive(drawingId: string, presenceId: string, isActive: boolean): boolean {
    const entry = this.byDrawing.get(drawingId)?.get(presenceId);
    if (!entry) return false;
    const changed = entry.isActive !== isActive;
    entry.isActive = isActive;
    if (!isActive) {
      entry.selectedElementIds = {};
      entry.allSelected = false;
    }
    return changed;
  }

  setSelection(
    drawingId: string,
    presenceId: string,
    elementIds: string[],
    allSelected = false,
  ): boolean {
    const entry = this.byDrawing.get(drawingId)?.get(presenceId);
    if (!entry || !entry.isActive) return false;
    entry.selectedElementIds = Object.fromEntries(elementIds.map((id) => [id, true]));
    entry.allSelected = allSelected;
    return true;
  }

  list(drawingId: string): PresenceEntry[] {
    return Array.from(this.byDrawing.get(drawingId)?.values() || []);
  }

  /** The same list, with what the room has no business knowing removed. */
  listPublic(drawingId: string): PublicPresenceEntry[] {
    return this.list(drawingId).map(toPublicPresence);
  }

  selectionSnapshot(drawingId: string): SelectionSnapshot {
    const selections: SelectionSnapshotEntry[] = [];
    for (const entry of this.list(drawingId)) {
      if (entry.allSelected) {
        selections.push({ presenceId: entry.presenceId, allSelected: true });
        continue;
      }
      const selectedElementIds = Object.keys(entry.selectedElementIds);
      if (selectedElementIds.length > 0) {
        selections.push({ presenceId: entry.presenceId, selectedElementIds });
      }
    }
    return {
      drawingId,
      selections,
    };
  }

  occupiedDrawingIds(): string[] {
    return Array.from(this.byDrawing.keys());
  }

  applyAgentFocus(event: BoardAgentFocusEvent, now = Date.now()): BoardAgentPresenceEntry {
    const entries = this.agentsByDrawing.get(event.drawingId) ?? new Map();
    const existing = entries.get(event.runId);
    const entry: BoardAgentPresenceEntry = {
      agentId: event.agentId,
      runId: event.runId,
      drawingId: event.drawingId,
      revisionId: event.revisionId,
      displayName: event.displayName,
      color: deriveAgentPresenceColor(event.runId),
      status: existing?.status ?? "working",
      focusActive: event.phase === "started",
      targetIds:
        event.phase === "started"
          ? [...event.targetIds]
          : event.targetIds.length > 0
            ? [...event.targetIds]
            : (existing?.targetIds ?? []),
      audience: event.audience,
      lastEventAt: now,
    };
    entries.set(event.runId, entry);
    this.agentsByDrawing.set(event.drawingId, entries);
    return entry;
  }

  applyAgentRuntime(
    event: BoardAgentRuntimePresenceEvent,
    now = Date.now(),
  ): BoardAgentPresenceEntry | null {
    if (event.status === "done") {
      this.removeAgent(event.drawingId, event.runId);
      return null;
    }
    const entries = this.agentsByDrawing.get(event.drawingId) ?? new Map();
    const existing = entries.get(event.runId);
    const entry: BoardAgentPresenceEntry = {
      agentId: event.agentId,
      runId: event.runId,
      drawingId: event.drawingId,
      revisionId: event.revisionId,
      displayName: event.displayName,
      color: deriveAgentPresenceColor(event.runId),
      status: event.status,
      focusActive: existing?.focusActive ?? false,
      targetIds: existing?.targetIds ?? [],
      audience: event.audience,
      lastEventAt: now,
    };
    entries.set(event.runId, entry);
    this.agentsByDrawing.set(event.drawingId, entries);
    return entry;
  }

  removeAgent(drawingId: string, runId: string): void {
    const entries = this.agentsByDrawing.get(drawingId);
    if (!entries) return;
    entries.delete(runId);
    if (entries.size === 0) this.agentsByDrawing.delete(drawingId);
  }

  agentRecipientIds(drawingId: string, audience: BoardAgentRunAudience): string[] {
    return this.list(drawingId)
      .filter((entry) => entry.receivesAgentEvents !== false)
      .filter((entry) => audience.kind === "drawing" || entry.accountId === audience.userId)
      .map((entry) => entry.presenceId);
  }

  listAgentsForViewer(
    drawingId: string,
    viewerAccountId: string | null,
  ): PublicBoardAgentPresenceEntry[] {
    return Array.from(this.agentsByDrawing.get(drawingId)?.values() ?? [])
      .filter(
        (entry) => entry.audience.kind === "drawing" || entry.audience.userId === viewerAccountId,
      )
      .sort((left, right) => left.runId.localeCompare(right.runId))
      .map(({ audience, lastEventAt: _lastEventAt, ...entry }) => ({
        ...entry,
        visibility: audience.kind,
      }));
  }

  /** Returns the exact audiences whose viewers need a clearing snapshot. */
  pruneStaleAgents(cutoff: number): StaleBoardAgentPresence[] {
    const changed: StaleBoardAgentPresence[] = [];
    for (const [drawingId, entries] of this.agentsByDrawing) {
      let removed = false;
      for (const [runId, entry] of entries) {
        if (entry.lastEventAt < cutoff) {
          entries.delete(runId);
          changed.push({ drawingId, audience: entry.audience });
          removed = true;
        }
      }
      if (!removed) continue;
      if (entries.size === 0) this.agentsByDrawing.delete(drawingId);
    }
    return changed;
  }

  /**
   * What a board looks like from the outside: one entry per person rather than
   * per connection, because two tabs are still one colleague, and guests as a
   * number, because an unauthenticated visitor cannot be told apart from the
   * same visitor reconnecting.
   */
  summarise(drawingId: string): PresenceSummary {
    const members = new Map<string, PresenceSummaryMember>();
    let guestCount = 0;
    for (const entry of this.byDrawing.get(drawingId)?.values() || []) {
      if (entry.kind === "guest" || !entry.accountId) {
        guestCount += 1;
        continue;
      }
      const existing = members.get(entry.accountId);
      if (!existing) {
        members.set(entry.accountId, {
          accountId: entry.accountId,
          name: entry.name,
          initials: entry.initials,
          color: entry.color,
          kind: entry.kind,
        });
        continue;
      }
      if (entry.kind === "owner") existing.kind = "owner";
    }
    return {
      members: Array.from(members.values()).sort((a, b) => a.name.localeCompare(b.name)),
      guestCount,
    };
  }
}

const AGENT_PRESENCE_COLORS = [
  "#7c3aed",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#d97706",
  "#dc2626",
] as const;

const deriveAgentPresenceColor = (runId: string): string => {
  let hash = 0;
  for (let index = 0; index < runId.length; index += 1) {
    hash = runId.charCodeAt(index) + ((hash << 5) - hash);
  }
  return AGENT_PRESENCE_COLORS[Math.abs(hash) % AGENT_PRESENCE_COLORS.length];
};
