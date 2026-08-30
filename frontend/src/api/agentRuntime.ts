import { API_URL, api } from "./client";
import { currentCsrfHeader } from "./auth";

declare const boardAgentRunStateBrand: unique symbol;

/** Validated board-gateway projection; provider states stay behind the backend adapter. */
export type BoardAgentRunState = ("working" | "idle" | "blocked" | "done" | "unknown") & {
  readonly [boardAgentRunStateBrand]: true;
};

const BOARD_AGENT_RUN_STATES = new Set(["working", "idle", "blocked", "done", "unknown"]);

const parseBoardAgentRunState = (value: unknown): BoardAgentRunState => {
  if (typeof value !== "string" || !BOARD_AGENT_RUN_STATES.has(value)) {
    throw new Error("Agent runtime returned an invalid run state");
  }
  return value as BoardAgentRunState;
};

export type AgentRuntimeConnection = {
  id: string;
  label: string;
  audience: { kind: "installation" | "user" };
  costBearer: { label: string };
  profiles: Array<{ id: string; label: string }>;
  health: { connected: boolean; status: "connected" | "disconnected" };
};

export type AgentRuntimeRun = {
  id: string;
  displayName: string;
  status: BoardAgentRunState;
  capabilities: string[];
};

export type RuntimeDaemonDevice = {
  id: string;
  label: string;
  daemonVersion: string;
  planLabel: string | null;
  limits: Array<{ label: string; value: string }> | null;
  revoked: boolean;
  lastSeenAt: string | null;
};

export const listRuntimeDaemons = async (): Promise<RuntimeDaemonDevice[]> => {
  const response = await api.get<{ daemons: RuntimeDaemonDevice[] }>("/agent/runtime-daemons");
  return response.data.daemons;
};

export const createRuntimeDaemonPairing = async (
  label: string,
): Promise<{ pairingCode: string; expiresAt: string }> => {
  const response = await api.post<{ pairingCode: string; expiresAt: string }>(
    "/agent/runtime-daemons/pairings",
    { label },
  );
  return response.data;
};

export const revokeRuntimeDaemon = async (daemonId: string): Promise<void> => {
  await api.delete(`/agent/runtime-daemons/${daemonId}`);
};

type AgentRuntimeRunWire = Omit<AgentRuntimeRun, "status"> & { status: unknown };

const parseAgentRuntimeRun = (run: AgentRuntimeRunWire): AgentRuntimeRun => ({
  ...run,
  status: parseBoardAgentRunState(run.status),
});

export const getAgentRuntimeConnections = async (
  drawingId: string,
): Promise<AgentRuntimeConnection[]> => {
  const response = await api.get<{ connections: AgentRuntimeConnection[] }>(
    `/drawings/${drawingId}/agent/runtime`,
  );
  return response.data.connections;
};

export const startAgentRuntimeRun = async (
  drawingId: string,
  input: {
    connectionId: string;
    profileId: string;
    displayName: string;
    initialPrompt?: string;
  },
): Promise<{ run: AgentRuntimeRun; runCapability: string; expiresAt: string }> => {
  const response = await api.post<{
    run: AgentRuntimeRunWire;
    runCapability: string;
    expiresAt: string;
  }>(`/drawings/${drawingId}/agent/run`, {
    ...input,
    approvedCapabilities: ["agent:read", "agent:run", "agent:prompt"],
  });
  return { ...response.data, run: parseAgentRuntimeRun(response.data.run) };
};

export const promptAgentRuntimeRun = async (
  drawingId: string,
  runCapability: string,
  text: string,
): Promise<Pick<AgentRuntimeRun, "id" | "status">> => {
  const response = await api.post<{ id: string; status: unknown }>(
    `/drawings/${drawingId}/agent/prompt`,
    {
      runCapability,
      text,
    },
  );
  return { ...response.data, status: parseBoardAgentRunState(response.data.status) };
};

/**
 * A POST event stream keeps the run capability out of URLs, proxy access
 * logs and browser history. The capability remains memory-only in the panel.
 */
export const subscribeAgentRuntimeRun = (
  drawingId: string,
  runCapability: string,
  listener: (
    event: Pick<AgentRuntimeRun, "id" | "status"> & Partial<Pick<AgentRuntimeRun, "displayName">>,
  ) => void,
  onDisconnect: () => void,
): (() => void) => {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`${API_URL}/drawings/${drawingId}/agent/events`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...currentCsrfHeader() },
        body: JSON.stringify({ runCapability }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Runtime event stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data) {
            const event = JSON.parse(data);
            if (event && typeof event.id === "string") {
              listener({
                id: event.id,
                status: parseBoardAgentRunState(event.status),
                ...(typeof event.displayName === "string"
                  ? { displayName: event.displayName }
                  : {}),
              });
            }
          }
          boundary = buffered.indexOf("\n\n");
        }
      }
      if (!controller.signal.aborted) onDisconnect();
    } catch {
      if (!controller.signal.aborted) onDisconnect();
    }
  })();
  return () => controller.abort();
};
