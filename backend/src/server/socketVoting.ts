import type { Server, Socket } from "socket.io";
import type { DrawingAccess } from "../authz/sharing";
import { parseDrawingId } from "./socketProtocol";
import { createRoomEventFeedback, type RoomEventAck } from "./socketRoomEvent";
import {
  parseVoteOptionLabels,
  parseVotePrompt,
  VotingRegistry,
  type VotingSnapshot,
} from "./votingRegistry";

export const VOTING_COMMAND_EVENT = "voting-command";
export const VOTING_CAST_EVENT = "voting-cast";
export const VOTING_STATE_EVENT = "voting-state";

const DEFAULT_MAX_SELECTIONS = 1;
const MAX_MAX_SELECTIONS = 12;

const roomName = (drawingId: string) => `drawing_${drawingId}`;

type OpenCommand = {
  readonly drawingId: string;
  readonly action: "open";
  readonly prompt: string;
  readonly options: readonly string[];
  readonly maxSelections: number;
};
type SimpleCommand = { readonly drawingId: string; readonly action: "reveal" | "close" };
type VotingCommand = OpenCommand | SimpleCommand;

const parseVotingCommand = (value: unknown): VotingCommand | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId) return null;
  if (data.action === "reveal" || data.action === "close") {
    return { drawingId, action: data.action };
  }
  if (data.action !== "open") return null;
  const prompt = parseVotePrompt(data.prompt);
  const options = parseVoteOptionLabels(data.options);
  if (!prompt || !options) return null;
  const maxSelections =
    data.maxSelections === undefined ? DEFAULT_MAX_SELECTIONS : data.maxSelections;
  if (
    typeof maxSelections !== "number" ||
    !Number.isInteger(maxSelections) ||
    maxSelections < 1 ||
    maxSelections > MAX_MAX_SELECTIONS
  ) {
    return null;
  }
  return { drawingId, action: "open", prompt, options, maxSelections };
};

type CastPayload = {
  readonly drawingId: string;
  readonly roundId: string;
  readonly optionIds: readonly string[];
};

const parseCastPayload = (value: unknown): CastPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId || typeof data.roundId !== "string" || !data.roundId) return null;
  if (!Array.isArray(data.optionIds) || data.optionIds.length === 0) return null;
  if (data.optionIds.length > MAX_MAX_SELECTIONS) return null;
  if (!data.optionIds.every((id): id is string => typeof id === "string")) return null;
  return { drawingId, roundId: data.roundId, optionIds: data.optionIds };
};

type SocketVotingManagerDeps = {
  io: Pick<Server, "to">;
  voting: VotingRegistry;
  requireAccess: (
    socket: Socket,
    drawingId: string,
    requireEdit?: boolean,
  ) => Promise<DrawingAccess | null>;
};

/**
 * Voting control (open/reveal/close) is gated at the same bar as the shared
 * workshop timer -- any editor, not only the current presenter. That mirrors
 * an existing, accepted precedent (`socketWorkshopTimer.ts`) rather than
 * inventing a second "is presenter" authority check; presenting and voting
 * are independent workshop tools that happen to be used together, not one
 * gating the other.
 */
export const createSocketVotingManager = ({
  io,
  voting,
  requireAccess,
}: SocketVotingManagerDeps) => {
  const emitState = (drawingId: string, snapshot: VotingSnapshot) => {
    io.to(roomName(drawingId)).emit(VOTING_STATE_EVENT, snapshot);
  };

  const registerHandlers = (
    socket: Socket,
    allowCommand: () => boolean,
    allowCast: () => boolean,
  ) => {
    const commandFeedback = createRoomEventFeedback(socket, VOTING_COMMAND_EVENT, 60_000);
    const castFeedback = createRoomEventFeedback(socket, VOTING_CAST_EVENT, 10_000);

    socket.on(VOTING_COMMAND_EVENT, async (data: unknown, ack?: RoomEventAck) => {
      if (!allowCommand()) {
        commandFeedback.rateLimited(ack);
        return;
      }
      const parsed = parseVotingCommand(data);
      if (!parsed) {
        commandFeedback.invalid(ack);
        return;
      }
      if (!(await requireAccess(socket, parsed.drawingId, true))) {
        commandFeedback.rejected(
          { code: "access-denied", message: `${VOTING_COMMAND_EVENT} access denied` },
          ack,
        );
        return;
      }
      if (parsed.action === "open") {
        const result = voting.open(
          parsed.drawingId,
          parsed.prompt,
          parsed.options,
          parsed.maxSelections,
        );
        if (result.status === "rejected") {
          commandFeedback.rejected({ code: result.reason, message: "Invalid voting round" }, ack);
          return;
        }
        emitState(parsed.drawingId, result.snapshot);
        commandFeedback.succeeded(ack);
        return;
      }
      if (parsed.action === "reveal") {
        const snapshot = voting.reveal(parsed.drawingId);
        if (!snapshot) {
          commandFeedback.rejected(
            { code: "no-open-round", message: "No voting round to reveal" },
            ack,
          );
          return;
        }
        emitState(parsed.drawingId, snapshot);
        commandFeedback.succeeded(ack);
        return;
      }
      // action === "close"
      emitState(parsed.drawingId, voting.close(parsed.drawingId));
      commandFeedback.succeeded(ack);
    });

    // Casting only needs view access -- audience votes, it does not moderate.
    socket.on(VOTING_CAST_EVENT, async (data: unknown, ack?: RoomEventAck) => {
      if (!allowCast()) {
        castFeedback.rateLimited(ack);
        return;
      }
      const parsed = parseCastPayload(data);
      if (!parsed) {
        castFeedback.invalid(ack);
        return;
      }
      if (!(await requireAccess(socket, parsed.drawingId))) {
        castFeedback.rejected(
          { code: "access-denied", message: `${VOTING_CAST_EVENT} access denied` },
          ack,
        );
        return;
      }
      if (!voting.castMatchesRound(parsed.drawingId, parsed.roundId)) {
        castFeedback.rejected(
          { code: "round-changed", message: "This voting round is no longer open" },
          ack,
        );
        return;
      }
      const result = voting.cast(parsed.drawingId, socket.id, parsed.optionIds);
      if (result.status === "rejected") {
        castFeedback.rejected(
          { code: result.reason, message: "Your ballot could not be recorded" },
          ack,
        );
        return;
      }
      // Deliberately nothing is broadcast: even a "someone voted" pulse
      // would leak participation timing while the round is meant to stay
      // concealed. The caster gets their own ack; the room gets nothing
      // until `reveal`.
      castFeedback.succeeded(ack);
    });
  };

  return { registerHandlers };
};

export type SocketVotingManager = ReturnType<typeof createSocketVotingManager>;
