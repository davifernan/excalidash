import type { Server } from "socket.io";
import type {
  BoardAgentFocusEvent,
  BoardAgentRunAudience,
  BoardAgentRuntimePresenceEvent,
} from "../agent/presence";
import type { PresenceRegistry } from "./presenceRegistry";

export const BOARD_AGENT_FOCUS_STARTED_EVENT = "agent.focus.started";
export const BOARD_AGENT_FOCUS_FINISHED_EVENT = "agent.focus.finished";
export const BOARD_AGENT_RUNTIME_EVENT = "agent.runtime.updated";
export const BOARD_AGENT_PRESENCE_EVENT = "agent.presence.updated";
export const BOARD_AGENT_PRESENCE_STALE_MS = 8_000;

const publicFocusEvent = ({ audience, ...event }: BoardAgentFocusEvent) => ({
  ...event,
  visibility: audience.kind,
});

const publicRuntimeEvent = ({ audience, ...event }: BoardAgentRuntimePresenceEvent) => ({
  ...event,
  visibility: audience.kind,
});

const emitAgentSnapshot = (
  io: Server,
  presences: PresenceRegistry,
  drawingId: string,
  presenceId: string,
  emitEmpty = true,
): void => {
  const viewer = presences.get(drawingId, presenceId);
  if (!viewer || viewer.receivesAgentEvents === false) return;
  const snapshot = presences.listAgentsForViewer(drawingId, viewer.accountId);
  if (snapshot.length === 0 && !emitEmpty) return;
  io.to(presenceId).emit(BOARD_AGENT_PRESENCE_EVENT, snapshot);
};

export const emitBoardAgentPresenceSnapshotToSocket = (params: {
  io: Server;
  presences: PresenceRegistry;
  drawingId: string;
  presenceId: string;
}): void =>
  emitAgentSnapshot(params.io, params.presences, params.drawingId, params.presenceId, false);

export const emitBoardAgentPresenceSnapshots = (params: {
  io: Server;
  presences: PresenceRegistry;
  drawingId: string;
  audiences?: readonly BoardAgentRunAudience[];
}): void => {
  const recipientIds = params.audiences
    ? new Set(
        params.audiences.flatMap((audience) =>
          params.presences.agentRecipientIds(params.drawingId, audience),
        ),
      )
    : new Set(params.presences.list(params.drawingId).map((viewer) => viewer.presenceId));
  for (const presenceId of recipientIds) {
    emitAgentSnapshot(params.io, params.presences, params.drawingId, presenceId);
  }
};

export const publishBoardAgentFocus = (params: {
  io: Server;
  presences: PresenceRegistry;
  event: BoardAgentFocusEvent;
}): void => {
  params.presences.applyAgentFocus(params.event);
  const eventName =
    params.event.phase === "started"
      ? BOARD_AGENT_FOCUS_STARTED_EVENT
      : BOARD_AGENT_FOCUS_FINISHED_EVENT;
  for (const presenceId of params.presences.agentRecipientIds(
    params.event.drawingId,
    params.event.audience,
  )) {
    params.io.to(presenceId).emit(eventName, publicFocusEvent(params.event));
    emitAgentSnapshot(params.io, params.presences, params.event.drawingId, presenceId);
  }
};

export const publishBoardAgentRuntime = (params: {
  io: Server;
  presences: PresenceRegistry;
  event: BoardAgentRuntimePresenceEvent;
}): void => {
  params.presences.applyAgentRuntime(params.event);
  for (const presenceId of params.presences.agentRecipientIds(
    params.event.drawingId,
    params.event.audience,
  )) {
    params.io.to(presenceId).emit(BOARD_AGENT_RUNTIME_EVENT, publicRuntimeEvent(params.event));
    emitAgentSnapshot(params.io, params.presences, params.event.drawingId, presenceId);
  }
};

export const toPresenceName = (value: unknown): string => {
  if (typeof value !== "string") return "User";
  const trimmed = value.trim().slice(0, 120);
  return trimmed || "User";
};

export const toPresenceInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || "U";
};

export const toPresenceColor = (value: unknown): string => {
  if (typeof value !== "string") return "#4f46e5";
  return /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : "#4f46e5";
};

/**
 * The same palette and hash the frontend uses for its own avatar
 * (`frontend/src/pages/editor/shared.ts`), so a person sees the colour everyone
 * else sees. It is derived here rather than read from the client: the colour is
 * how a team recognises each other, and a value the browser picks is a value a
 * browser can also pick to look like somebody else.
 */
const PRESENCE_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
] as const;

const hashSeed = (seed: string): number => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = seed.charCodeAt(index) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
};

export const derivePresenceColor = (seed: string): string =>
  PRESENCE_COLORS[hashSeed(seed) % PRESENCE_COLORS.length];

/**
 * The same cast the frontend has always given anonymous visitors
 * (`frontend/src/utils/identity.ts`), moved here.
 *
 * A visitor holding a share link is not an account, so nothing they send about
 * themselves can be checked -- including their name. Picking it here keeps a
 * guest from arriving as "Davi Fernandes" next to names the server read from
 * the database, and the name is still a name rather than a case number.
 */
const GUEST_NAMES = [
  "Optimus Prime",
  "Megatron",
  "Starscream",
  "Bumblebee",
  "Ultra Magnus",
  "Shockwave",
  "Soundwave",
  "Ironhide",
  "Ratchet",
  "Prowl",
  "Jazz",
  "Hot Rod",
  "Alpha Trion",
  "Wheeljack",
  "Sideswipe",
  "Sunstreaker",
  "Inferno",
  "Grapple",
  "Blaster",
  "Perceptor",
  "Trailbreaker",
  "Cosmos",
  "Warpath",
  "Powerglide",
  "Arcee",
  "Springer",
  "Kup",
  "Blurr",
  "Grimlock",
  "Swoop",
  "Skywarp",
  "Thundercracker",
  "Ramjet",
  "Cyclonus",
  "Scourge",
  "Galvatron",
  "Astrotrain",
  "Blitzwing",
  "Rumble",
  "Frenzy",
  "Laserbeak",
  "Ravage",
  "Unicron",
  "Devastator",
  "Menasor",
  "Bruticus",
  "Motormaster",
  "Scrapper",
  "Mixmaster",
  "Bonecrusher",
  "Hook",
  "Vortex",
  "Swindle",
  "Hans-Friedrich",
] as const;

export const deriveGuestName = (seed: string): string =>
  GUEST_NAMES[hashSeed(seed) % GUEST_NAMES.length];
