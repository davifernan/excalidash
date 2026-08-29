export const AGENT_BOARD_EXPLORE = "board:explore";
export const AGENT_BOARD_RENDER = "board:render";
export const AGENT_ASSET_READ = "asset:read";

export const AGENT_MOUNT_CAPABILITIES = [
  AGENT_BOARD_EXPLORE,
  AGENT_BOARD_RENDER,
  AGENT_ASSET_READ,
] as const;

export type AgentMountCapability = (typeof AGENT_MOUNT_CAPABILITIES)[number];

export class AgentContextAuthorizationError extends Error {
  constructor(
    public readonly code: "CONTEXT_NOT_READABLE" | "CAPABILITY_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "AgentContextAuthorizationError";
  }
}

/** Omitted means all contexts in the revision; an explicit empty list means none. */
export const resolveEffectiveAgentContextIds = (
  requested: readonly string[] | undefined,
  available: readonly string[],
): string[] => {
  const availableSet = new Set(available);
  const effective = requested === undefined ? available : [...new Set(requested)];
  if (effective.some((contextId) => !availableSet.has(contextId))) {
    // Do not identify which candidate was absent: ids are not authority and
    // this error must not become an existence oracle for a foreign Context.
    throw new AgentContextAuthorizationError(
      "CONTEXT_NOT_READABLE",
      "The requested Context set is not readable in this board revision.",
    );
  }
  return [...effective].sort();
};

export const requireAgentMountCapability = (
  capabilities: readonly string[],
  required: AgentMountCapability,
): void => {
  if (!capabilities.includes(required)) {
    throw new AgentContextAuthorizationError(
      "CAPABILITY_MISSING",
      "The run mount does not grant this capability.",
    );
  }
};

export const canReadAgentContext = (
  allowedContextIds: ReadonlySet<string>,
  contextId: string | null,
): boolean => contextId !== null && allowedContextIds.has(contextId);
