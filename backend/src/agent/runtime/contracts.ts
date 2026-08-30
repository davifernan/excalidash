export const AGENT_RUNTIME_CAPABILITIES = [
  "board:read",
  "agent:read",
  "agent:run",
  "agent:prompt",
  "artifact:publish",
  "board:write",
  "terminal:read",
  "terminal:input",
] as const;

export type AgentRuntimeCapability = (typeof AGENT_RUNTIME_CAPABILITIES)[number];
export type AgentRuntimeStatus = "working" | "idle" | "blocked" | "done" | "unknown";

export type AgentRuntimeProfile = {
  id: string;
  label: string;
};

/**
 * Who may spend a connection's runtime capacity.
 *
 * NIL-683 deliberately has not decided whether 0.15 is installation-local or
 * whether every person brings a runtime from their own laptop. Keeping that
 * choice in the connection audience lets the gateway support both without
 * exposing a transport or a provider concept to route callers.
 */
export type RuntimeConnectionAudience = { kind: "installation" } | { kind: "user"; userId: string };

export type AgentRuntimeConnection = {
  id: string;
  label: string;
  adapterId: string;
  audience: RuntimeConnectionAudience;
  profiles: readonly AgentRuntimeProfile[];
  policyCapabilities: readonly AgentRuntimeCapability[];
  /** Adapter-private configuration. Gateway and route code must not inspect it. */
  adapterConfig: unknown;
};

export type RuntimeHealth = {
  connected: boolean;
  status: "connected" | "disconnected";
};

export type RuntimeStartInput = {
  profileId: string;
  displayName: string;
  initialPrompt?: string;
  runId: string;
  drawingId: string;
  /** Stable public responsibility id; absent for an ordinary private run. */
  dispatchId?: string;
  /** Runtime-neutral mount handoff. Adapters decide how their transport carries it. */
  boardMount?: {
    revisionId: string;
    capabilityToken: string;
    allowedContextIds: readonly string[];
  };
};

export type RuntimeRun = {
  /** Opaque outside the owning adapter; it is never returned directly to a client. */
  handle: string;
  status: AgentRuntimeStatus;
  displayName: string;
};

export type RuntimeStatusEvent = {
  status: AgentRuntimeStatus;
  displayName?: string;
};

export type RuntimeSubscription = {
  close: () => void;
  /** Resolves when the runtime-side event stream ends or is closed. */
  closed: Promise<void>;
};

/**
 * The real replaceable seam. No Herdr workspace, pane, socket, method name or
 * status type crosses it; a second implementation only has to implement this
 * interface and register under another adapterId.
 */
export interface AgentRuntimeAdapter {
  readonly id: string;
  health(connection: AgentRuntimeConnection): Promise<RuntimeHealth>;
  start(connection: AgentRuntimeConnection, input: RuntimeStartInput): Promise<RuntimeRun>;
  prompt(
    connection: AgentRuntimeConnection,
    handle: string,
    text: string,
  ): Promise<RuntimeStatusEvent>;
  status(connection: AgentRuntimeConnection, handle: string): Promise<RuntimeStatusEvent>;
  subscribe(
    connection: AgentRuntimeConnection,
    handle: string,
    listener: (event: RuntimeStatusEvent) => void,
  ): Promise<RuntimeSubscription>;
}

export class AgentRuntimeError extends Error {
  constructor(
    public readonly code:
      | "RUNTIME_NOT_CONFIGURED"
      | "RUNTIME_NOT_CONNECTED"
      | "RUNTIME_PROFILE_NOT_FOUND"
      | "RUNTIME_RESPONSE_INVALID"
      | "RUNTIME_REQUEST_FAILED"
      | "RUN_CAPABILITY_INVALID"
      | "RUN_CAPABILITY_EXPIRED"
      | "RUN_CAPABILITY_FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}
