import type { Server } from "socket.io";
import type { OrchestratorThread } from "../agent/orchestratorThreads";
import type { AgentThreadEntry } from "../agent/contextThread";
import type { PresenceRegistry } from "./presenceRegistry";

export const BOARD_AGENT_THREAD_UPDATED_EVENT = "agent.thread.updated";
export const BOARD_AGENT_THREAD_EVENT_APPENDED_EVENT = "agent.thread.event.appended";

/**
 * Thread events reuse the exact recipient projection as Focus, Runtime and
 * Presence. Local history therefore cannot leak through a second room or a
 * frontend-only filter whose membership drifts from the established audience.
 */
export const publishBoardAgentThreadUpdated = (params: {
  io: Server;
  presences: PresenceRegistry;
  thread: OrchestratorThread;
}): void => {
  for (const presenceId of params.presences.agentRecipientIds(
    params.thread.drawingId,
    params.thread.audience,
  )) {
    params.io.to(presenceId).emit(BOARD_AGENT_THREAD_UPDATED_EVENT, params.thread);
  }
};

export const publishBoardAgentThreadEvent = (params: {
  io: Server;
  presences: PresenceRegistry;
  thread: OrchestratorThread;
  event: AgentThreadEntry;
}): void => {
  for (const presenceId of params.presences.agentRecipientIds(
    params.thread.drawingId,
    params.thread.audience,
  )) {
    params.io.to(presenceId).emit(BOARD_AGENT_THREAD_EVENT_APPENDED_EVENT, {
      threadId: params.thread.id,
      audience: params.thread.audience.kind,
      event: params.event,
    });
  }
};
