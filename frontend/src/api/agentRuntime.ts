import { API_URL, api } from "./client";
import { currentCsrfHeader } from "./auth";

export type AgentRuntimeStatus = "working" | "idle" | "blocked" | "done" | "unknown";

export type AgentRuntimeConnection = {
  id: string;
  label: string;
  audience: { kind: "installation" | "user" };
  profiles: Array<{ id: string; label: string }>;
  health: { connected: boolean; status: "connected" | "disconnected" };
};

export type AgentRuntimeRun = {
  id: string;
  displayName: string;
  status: AgentRuntimeStatus;
  capabilities: string[];
};

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
  const response = await api.post(`/drawings/${drawingId}/agent/run`, {
    ...input,
    approvedCapabilities: ["agent:read", "agent:run", "agent:prompt"],
  });
  return response.data;
};

export const promptAgentRuntimeRun = async (
  drawingId: string,
  runCapability: string,
  text: string,
): Promise<Pick<AgentRuntimeRun, "id" | "status">> => {
  const response = await api.post(`/drawings/${drawingId}/agent/prompt`, {
    runCapability,
    text,
  });
  return response.data;
};

/**
 * A POST event stream keeps the run capability out of URLs, proxy access
 * logs and browser history. The capability remains memory-only in the panel.
 */
export const subscribeAgentRuntimeRun = (
  drawingId: string,
  runCapability: string,
  listener: (event: Pick<AgentRuntimeRun, "id" | "status" | "displayName">) => void,
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
            if (event && typeof event.id === "string" && typeof event.status === "string") {
              listener(event);
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
