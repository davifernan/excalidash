import express from "express";
import { Prisma } from "../../generated/client";
import { getDrawingCapabilities } from "../../authz/capabilities";
import { canEditDrawing } from "../../authz/sharing";
import {
  confirmElementGuestProvenance,
  ElementGuestProvenanceConflictError,
  elementIdsInContextFrame,
  readElementGuestProvenance,
} from "../../agent/elementGuestProvenance";
import type { DrawingRouteContext } from "./drawingRouteContext";

const parseElementIds = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
  const ids = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 200,
  );
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return null;
  return ids;
};

class InvalidProvenanceConfirmationError extends Error {}
class ProvenanceConfirmationDeniedError extends Error {}

/**
 * The only HTTP seam that can turn a provenance row from true/unknown into
 * confirmed-clean. It is intentionally outside `/agent/*`: a board-scoped
 * agent token must never be able to approve its own input.
 */
export const registerElementGuestProvenanceRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    getRequestPrincipal,
    getShareToken,
    parseJsonField,
    logAuditEvent,
  } = context;

  app.post(
    "/drawings/:id/element-guest-provenance/confirm-clean",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const elementIds = parseElementIds(req.body?.elementIds);
      if (!elementIds) {
        return res.status(400).json({
          error: "Invalid element provenance confirmation",
          message: "elementIds must contain one to 100 unique element ids.",
        });
      }
      const principal = await getRequestPrincipal(req);
      try {
        const result = await prisma.$transaction(
          async (tx) => {
            const decision = await getDrawingCapabilities({
              prisma: tx as any,
              principal,
              drawingId: req.params.id,
              shareToken: getShareToken(req),
            });
            if (
              !canEditDrawing(decision.access) ||
              decision.isGuest ||
              principal?.apiKey ||
              req.user?.authCredentialType === "apiKey"
            ) {
              throw new ProvenanceConfirmationDeniedError();
            }

            const [drawing, contexts] = await Promise.all([
              tx.drawing.findUnique({
                where: { id: req.params.id },
                select: { elements: true },
              }),
              tx.agentContext.findMany({
                where: { drawingId: req.params.id },
                select: { frameElementId: true },
              }),
            ]);
            if (!drawing) throw new ProvenanceConfirmationDeniedError();
            const elements = parseJsonField<unknown[]>(drawing.elements, []).filter(
              (element): element is Record<string, unknown> =>
                typeof element === "object" && element !== null && !Array.isArray(element),
            );
            const contextElementIds = new Set(
              contexts.flatMap((entry) => elementIdsInContextFrame(elements, entry.frameElementId)),
            );
            if (elementIds.some((elementId) => !contextElementIds.has(elementId))) {
              throw new InvalidProvenanceConfirmationError();
            }
            await confirmElementGuestProvenance(tx as any, req.params.id, elementIds);
            return readElementGuestProvenance(tx as any, req.params.id, elementIds);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        // The audit seam is called unconditionally. Its configured provider
        // owns retention/delivery policy; this route never silently omits the
        // security event because a local feature flag was read differently.
        await logAuditEvent({
          userId: req.user.id,
          action: "element_guest_provenance_confirmed_clean",
          resource: `drawing:${req.params.id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: req.params.id, elementIds },
        });
        return res.json({ elements: result });
      } catch (error) {
        if (error instanceof ElementGuestProvenanceConflictError) {
          return res.status(409).json({
            error: "Element provenance changed",
            code: "ELEMENT_PROVENANCE_CONFLICT",
          });
        }
        if (error instanceof ProvenanceConfirmationDeniedError) {
          return res.status(404).json({ error: "Drawing not found" });
        }
        if (error instanceof InvalidProvenanceConfirmationError) {
          return res.status(409).json({
            error: "Element is not in an Agent Context",
            code: "ELEMENT_OUTSIDE_AGENT_CONTEXT",
          });
        }
        throw error;
      }
    }),
  );
};
