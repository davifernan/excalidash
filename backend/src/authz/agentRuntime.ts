import type { DrawingAccess, DrawingPrincipal } from "./sharing";
import {
  AGENT_RUNTIME_CAPABILITIES,
  type AgentRuntimeCapability,
} from "../agent/runtime/contracts";
import {
  AGENT_PROMPT_SCOPE,
  AGENT_READ_SCOPE,
  AGENT_RUN_SCOPE,
  ARTIFACT_PUBLISH_SCOPE,
  DRAWING_OPS_SCOPE,
  DRAWING_READ_SCOPE,
  TERMINAL_INPUT_SCOPE,
  TERMINAL_READ_SCOPE,
} from "../auth/apiKeys";

const ALL = new Set<AgentRuntimeCapability>(AGENT_RUNTIME_CAPABILITIES);

const capabilityForAgentTokenScope: Readonly<Record<string, AgentRuntimeCapability>> = {
  [DRAWING_READ_SCOPE]: "board:read",
  [DRAWING_OPS_SCOPE]: "board:write",
  [AGENT_READ_SCOPE]: "agent:read",
  [AGENT_RUN_SCOPE]: "agent:run",
  [AGENT_PROMPT_SCOPE]: "agent:prompt",
  [ARTIFACT_PUBLISH_SCOPE]: "artifact:publish",
  [TERMINAL_READ_SCOPE]: "terminal:read",
  [TERMINAL_INPUT_SCOPE]: "terminal:input",
};

const humanCapabilities = (
  access: DrawingAccess,
  principal: DrawingPrincipal,
): Set<AgentRuntimeCapability> => {
  const fromBoard = new Set<AgentRuntimeCapability>();
  if (access !== "none") {
    fromBoard.add("board:read");
    fromBoard.add("agent:read");
  }
  if (access === "edit" || access === "owner") {
    fromBoard.add("agent:run");
    fromBoard.add("agent:prompt");
    fromBoard.add("artifact:publish");
    fromBoard.add("board:write");
  }

  if (!principal.apiKey) return fromBoard;
  const fromKey = new Set<AgentRuntimeCapability>();
  for (const scope of principal.apiKey.scopes) {
    const capability = capabilityForAgentTokenScope[scope];
    if (capability) fromKey.add(capability);
  }
  return new Set([...fromBoard].filter((capability) => fromKey.has(capability)));
};

const normalized = (input: readonly string[]): Set<AgentRuntimeCapability> =>
  new Set(
    input.filter((candidate): candidate is AgentRuntimeCapability =>
      ALL.has(candidate as AgentRuntimeCapability),
    ),
  );

/** Delegation is always a four-way intersection; no input may widen another. */
export const resolveAgentRuntimeCapabilities = (params: {
  access: DrawingAccess;
  principal: DrawingPrincipal;
  approvedDispatch: readonly string[];
  contextPolicy: readonly string[];
  runtimePolicy: readonly string[];
}): AgentRuntimeCapability[] => {
  const human = humanCapabilities(params.access, params.principal);
  const dispatch = normalized(params.approvedDispatch);
  const context = normalized(params.contextPolicy);
  const runtime = normalized(params.runtimePolicy);
  return AGENT_RUNTIME_CAPABILITIES.filter(
    (capability) =>
      human.has(capability) &&
      dispatch.has(capability) &&
      context.has(capability) &&
      runtime.has(capability),
  );
};

export const runtimeSubject = (principal: DrawingPrincipal): string =>
  principal.apiKey
    ? `user:${principal.userId}:api-key:${principal.apiKey.id}`
    : `user:${principal.userId}`;
