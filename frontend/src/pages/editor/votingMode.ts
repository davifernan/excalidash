/**
 * Voting mode: client side.
 *
 * Deliberately dumb. Every guarantee -- concealment while open, idempotent
 * recast, a server-authoritative reveal -- lives in
 * backend/src/server/votingRegistry.ts. This module only parses what the
 * server sends and forwards what the user asked for; it never computes or
 * remembers a tally itself, so there is nothing here that could leak one
 * even by accident.
 */
import type { Socket } from "socket.io-client";
import type { PresenterCommandError, PresenterCommandOutcome } from "./presenterMode";

export const VOTING_COMMAND_EVENT = "voting-command";
export const VOTING_CAST_EVENT = "voting-cast";
export const VOTING_STATE_EVENT = "voting-state";

export type VotingStatus = "idle" | "open" | "revealed";
export type VoteOption = { readonly id: string; readonly label: string };

export type VotingSnapshot = {
  readonly drawingId: string;
  readonly status: VotingStatus;
  readonly roundId: string | null;
  readonly prompt: string | null;
  readonly options: readonly VoteOption[] | null;
  readonly maxSelections: number | null;
  readonly tally: Readonly<Record<string, number>> | null;
  readonly participantCount: number | null;
};

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

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseOptions = (value: unknown): readonly VoteOption[] | null => {
  if (!Array.isArray(value)) return null;
  const options: VoteOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { id, label } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string") return null;
    options.push({ id, label });
  }
  return options;
};

const parseTally = (value: unknown): Readonly<Record<string, number>> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tally: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (!isFiniteNumber(count)) return null;
    tally[key] = count;
  }
  return tally;
};

export const parseVotingSnapshot = (value: unknown, drawingId: string): VotingSnapshot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.drawingId !== drawingId) return null;
  if (data.status === "idle") return idleSnapshot(drawingId);
  if (data.status !== "open" && data.status !== "revealed") return null;
  if (typeof data.roundId !== "string" || typeof data.prompt !== "string") return null;
  const options = parseOptions(data.options);
  if (!options || !isFiniteNumber(data.maxSelections)) return null;
  const revealed = data.status === "revealed";
  const tally = revealed ? parseTally(data.tally) : null;
  if (revealed && !tally) return null;
  return {
    drawingId,
    status: data.status,
    roundId: data.roundId,
    prompt: data.prompt,
    options,
    maxSelections: data.maxSelections,
    tally,
    participantCount:
      revealed && isFiniteNumber(data.participantCount) ? data.participantCount : null,
  };
};

const emitWithAck = (
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<PresenterCommandOutcome> =>
  new Promise((resolve) => {
    socket.emit(event, payload, (ack: unknown) => {
      const data = ack as { ok?: boolean; error?: PresenterCommandError } | undefined;
      if (data?.ok) resolve({ ok: true });
      else
        resolve({
          ok: false,
          error: data?.error ?? { code: "unknown", message: "Command failed" },
        });
    });
  });

export const bindVotingMode = ({
  socket,
  drawingId,
  onStateChange,
}: {
  socket: Socket;
  drawingId: string;
  onStateChange: (snapshot: VotingSnapshot) => void;
}) => {
  const onState = (value: unknown) => {
    const snapshot = parseVotingSnapshot(value, drawingId);
    if (snapshot) onStateChange(snapshot);
  };
  socket.on(VOTING_STATE_EVENT, onState);

  const reset = () => onStateChange(idleSnapshot(drawingId));

  return {
    reset,
    dispose() {
      socket.off(VOTING_STATE_EVENT, onState);
    },
    open: (prompt: string, options: readonly string[], maxSelections: number) =>
      emitWithAck(socket, VOTING_COMMAND_EVENT, {
        drawingId,
        action: "open",
        prompt,
        options,
        maxSelections,
      }),
    reveal: () => emitWithAck(socket, VOTING_COMMAND_EVENT, { drawingId, action: "reveal" }),
    close: () => emitWithAck(socket, VOTING_COMMAND_EVENT, { drawingId, action: "close" }),
    cast: (roundId: string, optionIds: readonly string[]) =>
      emitWithAck(socket, VOTING_CAST_EVENT, { drawingId, roundId, optionIds }),
  };
};

export type VotingModeController = ReturnType<typeof bindVotingMode>;
