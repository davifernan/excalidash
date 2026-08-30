import { api } from "./client";

export type AgentThreadAudience = { kind: "private"; userId: string } | { kind: "drawing" };

export type OrchestratorThreadDTO = {
  id: string;
  drawingId: string;
  audience: AgentThreadAudience;
  title: string;
  anchor: { kind: "private"; x: number; y: number } | { kind: "drawing"; elementId: string };
  createdAt: string;
  updatedAt: string;
};

export type AgentThreadEventDTO = {
  id: string;
  threadId: string;
  sequence: number;
  actor: { kind: "user" | "agent" | "system"; id: string | null; displayName: string };
  kind: "message" | "tool" | "status" | "artifact" | "dispatch" | "edit" | "retract";
  payload: Record<string, unknown>;
  createdAt: string;
};

export const getOrchestratorThreads = async (
  drawingId: string,
): Promise<OrchestratorThreadDTO[]> => {
  const response = await api.get<{ threads: OrchestratorThreadDTO[] }>(
    `/drawings/${drawingId}/orchestrator-threads`,
  );
  return response.data.threads;
};

export const getOrCreateLocalOrchestratorThread = async (
  drawingId: string,
  anchor: { x: number; y: number },
): Promise<OrchestratorThreadDTO> => {
  const response = await api.post<{ thread: OrchestratorThreadDTO }>(
    `/drawings/${drawingId}/orchestrator-threads/local`,
    { anchor },
  );
  return response.data.thread;
};

export const registerSharedOrchestratorThread = async (
  drawingId: string,
  anchorElementId: string,
): Promise<OrchestratorThreadDTO> => {
  const response = await api.post<{ thread: OrchestratorThreadDTO }>(
    `/drawings/${drawingId}/orchestrator-threads/shared`,
    { anchorElementId },
  );
  return response.data.thread;
};

export const moveLocalOrchestratorThread = async (
  drawingId: string,
  threadId: string,
  anchor: { x: number; y: number },
): Promise<OrchestratorThreadDTO> => {
  const response = await api.patch<{ thread: OrchestratorThreadDTO }>(
    `/drawings/${drawingId}/orchestrator-threads/${threadId}/local-anchor`,
    { anchor },
  );
  return response.data.thread;
};

export const getOrchestratorThreadEvents = async (
  drawingId: string,
  threadId: string,
): Promise<AgentThreadEventDTO[]> => {
  const response = await api.get<{ events: AgentThreadEventDTO[] }>(
    `/drawings/${drawingId}/orchestrator-threads/${threadId}/events`,
  );
  return response.data.events;
};

export const appendOrchestratorThreadMessage = async (
  drawingId: string,
  threadId: string,
  text: string,
): Promise<AgentThreadEventDTO> => {
  const response = await api.post<{ event: AgentThreadEventDTO }>(
    `/drawings/${drawingId}/orchestrator-threads/${threadId}/events`,
    { text },
  );
  return response.data.event;
};
