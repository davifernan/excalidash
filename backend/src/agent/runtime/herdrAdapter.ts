import {
  AgentRuntimeError,
  type AgentRuntimeAdapter,
  type AgentRuntimeConnection,
  type AgentRuntimeStatus,
  type RuntimeStartInput,
  type RuntimeStatusEvent,
} from "./contracts";
import { UnixHerdrTransport, type HerdrTransport } from "./herdrTransport";

export type HerdrProfileConfig = {
  id: string;
  label: string;
  agentKind: string;
  args: string[];
};

export type HerdrConnectionConfig = {
  socketPath: string;
  workingDirectory: string;
  profiles: HerdrProfileConfig[];
};

type HerdrHandle = { paneId: string; workspaceId: string };

const configOf = (connection: AgentRuntimeConnection): HerdrConnectionConfig => {
  const value = connection.adapterConfig as Partial<HerdrConnectionConfig> | null;
  if (
    !value ||
    typeof value.socketPath !== "string" ||
    typeof value.workingDirectory !== "string" ||
    !Array.isArray(value.profiles)
  ) {
    throw new AgentRuntimeError("RUNTIME_NOT_CONFIGURED", "Herdr connection is not configured.");
  }
  return value as HerdrConnectionConfig;
};

const encodeHandle = (handle: HerdrHandle): string =>
  Buffer.from(JSON.stringify(handle), "utf8").toString("base64url");

const decodeHandle = (handle: string): HerdrHandle => {
  try {
    const value = JSON.parse(Buffer.from(handle, "base64url").toString("utf8"));
    if (
      value &&
      typeof value === "object" &&
      typeof value.paneId === "string" &&
      typeof value.workspaceId === "string"
    ) {
      return value as HerdrHandle;
    }
  } catch {
    // Converted to the stable adapter error below.
  }
  throw new AgentRuntimeError("RUNTIME_RESPONSE_INVALID", "Runtime handle is invalid.");
};

const statusOf = (value: unknown): AgentRuntimeStatus =>
  value === "working" || value === "idle" || value === "blocked" || value === "done"
    ? value
    : "unknown";

const agentResult = (result: Record<string, unknown>): Record<string, unknown> => {
  const agent = result.agent;
  if (!agent || typeof agent !== "object") {
    throw new AgentRuntimeError("RUNTIME_RESPONSE_INVALID", "Runtime omitted the agent state.");
  }
  return agent as Record<string, unknown>;
};

export class HerdrAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "herdr";

  constructor(private readonly transport: HerdrTransport = new UnixHerdrTransport()) {}

  async health(connection: AgentRuntimeConnection) {
    try {
      const result = await this.transport.request(configOf(connection).socketPath, "ping", {});
      return {
        connected: result.type === "pong",
        status: result.type === "pong" ? ("connected" as const) : ("disconnected" as const),
      };
    } catch {
      return { connected: false, status: "disconnected" as const };
    }
  }

  async start(connection: AgentRuntimeConnection, input: RuntimeStartInput) {
    const config = configOf(connection);
    const profile = config.profiles.find((candidate) => candidate.id === input.profileId);
    if (!profile) {
      throw new AgentRuntimeError("RUNTIME_PROFILE_NOT_FOUND", "Runtime profile was not found.");
    }
    const workspaceResult = await this.transport.request(config.socketPath, "workspace.create", {
      cwd: config.workingDirectory,
      focus: false,
      label: input.displayName,
      env: {
        EXCALIDASH_RUN_ID: input.runId,
        EXCALIDASH_DRAWING_ID: input.drawingId,
        ...(input.dispatchId ? { EXCALIDASH_DISPATCH_ID: input.dispatchId } : {}),
        ...(input.boardMount
          ? {
              EXCALIDASH_REVISION_ID: input.boardMount.revisionId,
              EXCALIDASH_MOUNT_TOKEN: input.boardMount.capabilityToken,
              EXCALIDASH_ALLOWED_CONTEXT_IDS: JSON.stringify(input.boardMount.allowedContextIds),
            }
          : {}),
      },
    });
    const workspace = workspaceResult.workspace as Record<string, unknown> | undefined;
    const rootPane = workspaceResult.root_pane as Record<string, unknown> | undefined;
    if (typeof workspace?.workspace_id !== "string" || typeof rootPane?.pane_id !== "string") {
      throw new AgentRuntimeError(
        "RUNTIME_RESPONSE_INVALID",
        "Runtime omitted the created workspace.",
      );
    }

    try {
      const startedResult = await this.transport.request(config.socketPath, "agent.start", {
        name: input.displayName,
        kind: profile.agentKind,
        pane_id: rootPane.pane_id,
        args: profile.args,
        timeout_ms: 30_000,
      });
      let agent = agentResult(startedResult);
      if (input.initialPrompt) {
        agent = agentResult(
          await this.transport.request(config.socketPath, "agent.prompt", {
            target: rootPane.pane_id,
            text: input.initialPrompt,
          }),
        );
      }
      return {
        handle: encodeHandle({ paneId: rootPane.pane_id, workspaceId: workspace.workspace_id }),
        status: statusOf(agent.agent_status),
        displayName:
          typeof agent.name === "string" && agent.name.length > 0 ? agent.name : input.displayName,
      };
    } catch (error) {
      await this.transport
        .request(config.socketPath, "workspace.close", { workspace_id: workspace.workspace_id })
        .catch(() => undefined);
      throw error;
    }
  }

  async prompt(
    connection: AgentRuntimeConnection,
    handle: string,
    text: string,
  ): Promise<RuntimeStatusEvent> {
    const config = configOf(connection);
    const target = decodeHandle(handle);
    const agent = agentResult(
      await this.transport.request(config.socketPath, "agent.prompt", {
        target: target.paneId,
        text,
      }),
    );
    return {
      status: statusOf(agent.agent_status),
      displayName: typeof agent.name === "string" ? agent.name : undefined,
    };
  }

  async status(connection: AgentRuntimeConnection, handle: string): Promise<RuntimeStatusEvent> {
    const config = configOf(connection);
    const target = decodeHandle(handle);
    const agent = agentResult(
      await this.transport.request(config.socketPath, "agent.get", { target: target.paneId }),
    );
    return {
      status: statusOf(agent.agent_status),
      displayName: typeof agent.name === "string" ? agent.name : undefined,
    };
  }

  async subscribe(
    connection: AgentRuntimeConnection,
    handle: string,
    listener: (event: RuntimeStatusEvent) => void,
  ) {
    const config = configOf(connection);
    const target = decodeHandle(handle);
    return this.transport.subscribe(
      config.socketPath,
      [{ type: "pane.agent_status_changed", pane_id: target.paneId }],
      (envelope) => {
        if (envelope.event !== "pane.agent_status_changed") return;
        const data = envelope.data as Record<string, unknown> | undefined;
        if (!data || data.pane_id !== target.paneId) return;
        listener({
          status: statusOf(data.agent_status),
          displayName:
            typeof data.display_agent === "string"
              ? data.display_agent
              : typeof data.agent === "string"
                ? data.agent
                : undefined,
        });
      },
    );
  }
}
