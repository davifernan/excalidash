import type { AgentToolName } from "./boardMount";

export type BoardAgentRunAudience = { kind: "private"; userId: string } | { kind: "drawing" };

export type BoardAgentFocusEvent = {
  phase: "started" | "finished";
  agentId: string;
  runId: string;
  drawingId: string;
  revisionId: string;
  displayName: string;
  targetIds: readonly string[];
  audience: BoardAgentRunAudience;
  occurredAt: string;
};

export type BoardAgentRuntimePresenceEvent = {
  agentId: string;
  runId: string;
  drawingId: string;
  revisionId: string;
  displayName: string;
  status: "working" | "idle" | "blocked" | "done" | "unknown";
  audience: BoardAgentRunAudience;
  occurredAt: string;
};

const FOCUS_ELIGIBLE_TOOLS: ReadonlySet<AgentToolName> = new Set([
  "readFrame",
  "readElements",
  "search",
  "neighbors",
  "followEdge",
  "render",
]);

const MAX_FOCUS_TARGETS = 50;

const projectedId = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const projectedIds = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  return value.map(projectedId).filter((id): id is string => id !== null);
};

/** IDs come only from the already-authorized tool result projection. */
export const boardAgentFocusTargetsFromResult = (
  tool: AgentToolName,
  result: unknown,
): readonly string[] => {
  if (!FOCUS_ELIGIBLE_TOOLS.has(tool)) return [];
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  let ids: readonly string[];
  switch (tool) {
    case "readFrame":
      ids = [projectedId(record.frame)].filter((id): id is string => id !== null);
      break;
    case "readElements":
    case "search":
    case "neighbors":
      ids = projectedIds(result);
      break;
    case "followEdge":
      ids = [record.edge, record.start, record.end]
        .map(projectedId)
        .filter((id): id is string => id !== null);
      break;
    // render() has no element ids in its result. Its Context frame is
    // resolved and authorized from the request before execution instead.
    default:
      ids = [];
  }
  return [...new Set(ids)].slice(0, MAX_FOCUS_TARGETS);
};

export const boardAgentAudienceFromMount = (mount: {
  audienceKind: string;
  audienceUserId: string | null;
}): BoardAgentRunAudience | null => {
  if (mount.audienceKind === "drawing") return { kind: "drawing" };
  if (mount.audienceKind === "private" && mount.audienceUserId) {
    return { kind: "private", userId: mount.audienceUserId };
  }
  return null;
};
