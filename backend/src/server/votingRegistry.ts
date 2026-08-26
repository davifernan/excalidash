/**
 * A voting round with a concealed running tally.
 *
 * The concealment is structural, not a client-side hide: nothing in this
 * module can produce a count while a round is open. `cast` returns nothing
 * about the round's state at all, `snapshot` omits `tally` unless the round
 * has been revealed, and there is no method that reads the size of a vote
 * map without also checking `status`. A client that wanted the running count
 * anyway has no call to make -- the same bar
 * docs/architecture/EXCALIDRAW_ADAPTER.md's boundary holds for raw API calls,
 * applied to a tally instead of a seam.
 *
 * Nothing here is persisted, matching every other room-scoped registry in
 * this directory (presenceRegistry.ts, presenterRegistry.ts,
 * socketWorkshopTimer.ts): a vote is a fact about an open connection, and a
 * process restart mid-round loses it the same way a restart mid-presentation
 * loses the presenter.
 */
import crypto from "crypto";
import type { VoteOption, VotingSnapshot, VotingStatus } from "@excalidash/domain/collaboration";

export type { VoteOption, VotingSnapshot, VotingStatus } from "@excalidash/domain/collaboration";

type VoteRound = {
  roundId: string;
  prompt: string;
  options: readonly VoteOption[];
  maxSelections: number;
  status: "open" | "revealed";
  votesByVoterId: Map<string, ReadonlySet<string>>;
  revealedTally: Readonly<Record<string, number>> | null;
};

/** String-tagged, not boolean -- see presenterRegistry.ts's PresenterCommandResult comment. */
export type VotingOpenResult =
  | { readonly status: "applied"; readonly snapshot: VotingSnapshot }
  | { readonly status: "rejected"; readonly reason: "invalid-round" };

export type VotingCastResult =
  | { readonly status: "applied" }
  | {
      readonly status: "rejected";
      readonly reason: "no-open-round" | "round-changed" | "invalid-ballot";
    };

const MAX_OPTIONS = 12;
const MIN_OPTIONS = 2;
const MAX_PROMPT_LENGTH = 300;
const MAX_LABEL_LENGTH = 120;

const idleSnapshot = (drawingId: string): VotingSnapshot => ({
  drawingId,
  status: "idle",
  roundId: null,
  prompt: null,
  options: null,
  maxSelections: null,
  tally: null,
  participantCount: null,
});

export const parseVoteOptionLabels = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) return null;
  if (value.length < MIN_OPTIONS || value.length > MAX_OPTIONS) return null;
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const label = entry.trim();
    if (!label || label.length > MAX_LABEL_LENGTH) return null;
    labels.push(label);
  }
  return labels;
};

export const parseVotePrompt = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return null;
  return prompt;
};

export class VotingRegistry {
  private readonly byDrawing = new Map<string, VoteRound>();

  snapshot(drawingId: string): VotingSnapshot {
    const round = this.byDrawing.get(drawingId);
    if (!round) return idleSnapshot(drawingId);
    return {
      drawingId,
      status: round.status,
      roundId: round.roundId,
      prompt: round.prompt,
      options: round.options,
      maxSelections: round.maxSelections,
      tally: round.status === "revealed" ? round.revealedTally : null,
      participantCount: round.status === "revealed" ? round.votesByVoterId.size : null,
    };
  }

  /** Always starts a fresh round; an un-revealed previous round is discarded. */
  open(
    drawingId: string,
    prompt: string,
    labels: readonly string[],
    maxSelections: number,
  ): VotingOpenResult {
    if (
      labels.length < MIN_OPTIONS ||
      labels.length > MAX_OPTIONS ||
      !Number.isInteger(maxSelections) ||
      maxSelections < 1 ||
      maxSelections > labels.length
    ) {
      return { status: "rejected", reason: "invalid-round" };
    }
    const round: VoteRound = {
      roundId: crypto.randomBytes(12).toString("base64url"),
      prompt,
      options: labels.map((label, index) => ({ id: String(index), label })),
      maxSelections,
      status: "open",
      votesByVoterId: new Map(),
      revealedTally: null,
    };
    this.byDrawing.set(drawingId, round);
    return { status: "applied", snapshot: this.snapshot(drawingId) };
  }

  /**
   * Replace this voter's whole ballot. Not a toggle: a toggle is not
   * replay-safe (sending the same message twice would flip the vote back
   * off), and re-sending the same `optionIds` here is a true no-op --
   * exactly what "Doppel-/Replay-Stimmen sind idempotent" asks for.
   */
  cast(drawingId: string, voterId: string, optionIds: readonly string[]): VotingCastResult {
    const round = this.byDrawing.get(drawingId);
    if (!round || round.status !== "open") return { status: "rejected", reason: "no-open-round" };
    const validIds = new Set(round.options.map((option) => option.id));
    const unique = new Set(optionIds);
    if (
      unique.size === 0 ||
      unique.size > round.maxSelections ||
      [...unique].some((id) => !validIds.has(id))
    ) {
      return { status: "rejected", reason: "invalid-ballot" };
    }
    round.votesByVoterId.set(voterId, unique);
    return { status: "applied" };
  }

  castMatchesRound(drawingId: string, roundId: string): boolean {
    return this.byDrawing.get(drawingId)?.roundId === roundId;
  }

  reveal(drawingId: string): VotingSnapshot | null {
    const round = this.byDrawing.get(drawingId);
    if (!round) return null;
    if (round.status === "open") {
      const tally: Record<string, number> = {};
      for (const option of round.options) tally[option.id] = 0;
      for (const selections of round.votesByVoterId.values()) {
        for (const optionId of selections) tally[optionId] = (tally[optionId] ?? 0) + 1;
      }
      round.status = "revealed";
      round.revealedTally = tally;
    }
    return this.snapshot(drawingId);
  }

  close(drawingId: string): VotingSnapshot {
    this.byDrawing.delete(drawingId);
    return idleSnapshot(drawingId);
  }

  clear(drawingId: string): void {
    this.byDrawing.delete(drawingId);
  }
}
