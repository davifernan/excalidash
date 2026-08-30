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

export type PublicDispatchReceipt = {
  id: string;
  drawingId: string;
  publicThreadId: string;
  originVisibility: "private" | "drawing";
  objectiveSummary: string;
  targetContextIds: string[];
  revisionId: string;
  effectiveCapabilities: string[];
  expectedArtifacts: string[];
  runId: string;
  admission: "accepted" | "rejected";
  execution:
    | "queued"
    | "runtime_acknowledged"
    | "running"
    | "blocked"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "outcome_unknown";
  effect: "not_requested" | "pending" | "committed" | "rejected" | "failed";
  acceptedAt: string;
  lastObservedAt: string | null;
  effectEvidence: Record<string, unknown> | null;
  /** Server transition clock; used to reject a late, older HTTP snapshot. */
  updatedAt: string;
};

export type PublicDispatchInput = {
  publicThreadId: string;
  objectiveSummary: string;
  targetContextIds: string[];
  connectionId: string;
  profileId: string;
  displayName: string;
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

export const getPublicDispatchReceipts = async (
  drawingId: string,
  publicThreadId: string,
): Promise<PublicDispatchReceipt[]> =>
  (
    await api.get<{ receipts: PublicDispatchReceipt[] }>(
      `/drawings/${drawingId}/orchestrator-threads/${publicThreadId}/dispatches`,
    )
  ).data.receipts;

export const createPublicDispatch = async (
  drawingId: string,
  originThreadId: string,
  input: PublicDispatchInput,
): Promise<PublicDispatchReceipt> =>
  (
    await api.post<{ receipt: PublicDispatchReceipt }>(
      `/drawings/${drawingId}/orchestrator-threads/${originThreadId}/dispatches`,
      {
        ...input,
        requestedCapabilities: ["agent:read", "agent:run", "board:read", "board:write"],
        budget: { maxRuntimeMs: 10 * 60_000 },
        expectedArtifacts: ["Board update"],
        approval: { publicEffect: true },
      },
    )
  ).data.receipt;
