import type { Server } from "socket.io";
import type { DispatchReceiptProjection } from "../agent/dispatchReceipt";
import type { PresenceRegistry } from "./presenceRegistry";

export const BOARD_AGENT_DISPATCH_RECEIPT_EVENT = "agent.dispatch.receipt.updated";

/** Public-effect receipts use the existing drawing audience projection. */
export const publishBoardAgentDispatchReceipt = (params: {
  io: Server;
  presences: PresenceRegistry;
  receipt: DispatchReceiptProjection;
}): void => {
  for (const presenceId of params.presences.agentRecipientIds(params.receipt.drawingId, {
    kind: "drawing",
  })) {
    params.io.to(presenceId).emit(BOARD_AGENT_DISPATCH_RECEIPT_EVENT, params.receipt);
  }
};
