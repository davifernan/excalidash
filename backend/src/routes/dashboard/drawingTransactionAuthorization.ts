import { Prisma, type PrismaClient } from "../../generated/client";
import { getDrawingCapabilities, type DrawingCapabilityDecision } from "../../authz/capabilities";
import { canEditDrawing, type DrawingPrincipal } from "../../authz/sharing";

export class DrawingAccessRevokedError extends Error {
  constructor() {
    super("Drawing edit access was revoked before the write committed");
    this.name = "DrawingAccessRevokedError";
  }
}

/**
 * Re-resolve edit access through the transaction that is about to write.
 *
 * This guard is deliberately unconditional: appState, files, history, and
 * element writes are all writes. Letting the request payload decide whether
 * authorization is refreshed creates a TOCTOU path for whichever fields are
 * left outside that condition.
 */
export const assertDrawingStillEditable = async (params: {
  prisma: PrismaClient | Prisma.TransactionClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  shareToken?: string | null;
}): Promise<DrawingCapabilityDecision> => {
  const decision = await getDrawingCapabilities({
    prisma: params.prisma as PrismaClient,
    principal: params.principal,
    drawingId: params.drawingId,
    shareToken: params.shareToken,
  });
  if (!canEditDrawing(decision.access)) throw new DrawingAccessRevokedError();
  return decision;
};
