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
  /**
   * Who is behind this connection: a person, or something acting on a person's
   * behalf through an API key.
   *
   * One classification, set once at the join boundary, that every view below
   * derives from. It replaces `receivesAgentEvents`, which answered only one of
   * the questions the distinction governs -- and that is exactly how an
   * automation ended up drawn as a participant: the routing side knew, the
   * roster side did not. A second boolean per behaviour would repeat the
   * mistake with more parts.
   */
  actor: PresenceActor;
};

/** A person, or an automation acting through someone's API key. */
export type PresenceActor = "human" | "automation";

/** Views that describe who is on a board show people; automations are not people. */
const isHuman = (entry: PresenceEntry): boolean => entry.actor === "human";

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
  "accountId" | "selectedElementIds" | "allSelected" | "actor"
>;

export const toPublicPresence = ({
  accountId: _accountId,
  selectedElementIds: _selectedElementIds,
  allSelected: _allSelected,
  actor: _actor,
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
  /** Server-only ordering key for runtime events; never sent to viewers. */
  runtimeOccurredAt: number;
};

export type PublicBoardAgentPresenceEntry = Omit<
  BoardAgentPresenceEntry,
  "audience" | "lastEventAt" | "runtimeOccurredAt"
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
    // Refused for an automation rather than filtered afterwards: the caller
    // broadcasts a live `selection-update` to the room on a true return, and
    // that path never consults the projections below. Saying no here keeps the
    // handler's shape and closes the live path with it.
    if (!entry || !entry.isActive || !isHuman(entry)) return false;
    entry.selectedElementIds = Object.fromEntries(elementIds.map((id) => [id, true]));
    entry.allSelected = allSelected;
    return true;
  }

  list(drawingId: string): PresenceEntry[] {
    return Array.from(this.byDrawing.get(drawingId)?.values() || []);
  }

  /**
   * The people on this board, with what the room has no business knowing
   * removed. Automations are absent: an API key carries its owner's name and
   * colour, so one that appeared here would be indistinguishable from the
   * person -- and several of them made that person appear several times.
   */
  listPublic(drawingId: string): PublicPresenceEntry[] {
    return this.list(drawingId).filter(isHuman).map(toPublicPresence);
  }

  selectionSnapshot(drawingId: string): SelectionSnapshot {
    const selections: SelectionSnapshotEntry[] = [];
    // Humans only: a selection is drawn as somebody's selection, and an
    // automation's would be rendered under its key owner's name.
    for (const entry of this.list(drawingId).filter(isHuman)) {
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
      runtimeOccurredAt: existing?.runtimeOccurredAt ?? Number.NEGATIVE_INFINITY,
    };
    entries.set(event.runId, entry);
    this.agentsByDrawing.set(event.drawingId, entries);
    return entry;
  }

  applyAgentRuntime(
    event: BoardAgentRuntimePresenceEvent,
    now = Date.now(),
  ): { entry: BoardAgentPresenceEntry | null; applied: boolean } {
    const runtimeOccurredAt = Date.parse(event.occurredAt);
    const orderedAt = Number.isFinite(runtimeOccurredAt) ? runtimeOccurredAt : now;
    const existing = this.agentsByDrawing.get(event.drawingId)?.get(event.runId);
    // The stream queue preserves arrival order for equal millisecond stamps;
    // only a strictly older event may never replace the current runtime state.
    if (existing && orderedAt < existing.runtimeOccurredAt) {
      return { entry: existing, applied: false };
    }
    if (event.status === "done") {
      this.removeAgent(event.drawingId, event.runId);
      return { entry: null, applied: true };
    }
    const entries = this.agentsByDrawing.get(event.drawingId) ?? new Map();
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
      runtimeOccurredAt: orderedAt,
    };
    entries.set(event.runId, entry);
    this.agentsByDrawing.set(event.drawingId, entries);
    return { entry, applied: true };
  }

  removeAgent(drawingId: string, runId: string): void {
    const entries = this.agentsByDrawing.get(drawingId);
    if (!entries) return;
    entries.delete(runId);
    if (entries.size === 0) this.agentsByDrawing.delete(drawingId);
  }

  agentRecipientIds(drawingId: string, audience: BoardAgentRunAudience): string[] {
    return this.list(drawingId)
      .filter(isHuman)
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
      .map(
        ({
          audience,
          lastEventAt: _lastEventAt,
          runtimeOccurredAt: _runtimeOccurredAt,
          ...entry
        }) => ({
          ...entry,
          visibility: audience.kind,
        }),
      );
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
   *
   * Automations are excluded, and here the stake is higher than a duplicate:
   * grouping by account would fold an API key silently into its owner, so the
   * board would report that a person is present when only their key is.
   */
  summarise(drawingId: string): PresenceSummary {
    const members = new Map<string, PresenceSummaryMember>();
    let guestCount = 0;
    for (const entry of this.list(drawingId).filter(isHuman)) {
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
