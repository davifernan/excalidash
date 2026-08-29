import express from "express";
import { controlsDrawing } from "../../authz/membership";
import {
  combineGuestCapabilities,
  getBoardGuestCapabilityPolicy,
  getInstanceGuestCapabilities,
  setBoardGuestCapabilityPolicy,
} from "../../authz/capabilities";
import { guestCapabilityToggleSchema } from "../../auth/schemas";
import type { DrawingRouteContext } from "./drawingRouteContext";

/**
 * NIL-633's board half of NIL-615's guest policy. The instance ceiling from
 * auth/adminGuestCapabilityRoutes.ts is read-only here -- a board can see it
 * (so the UI can explain why a toggle is locked) but never write it.
 *
 * Authorization is controlsDrawing, the same "who may hand this board to
 * someone else" check drawingSharingRoutes.ts uses -- setting a guest policy
 * is exactly that kind of decision, and a guest who reached the board through
 * a link is never a member, so they can never satisfy it themselves.
 */
export const registerGuestCapabilityRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const { prisma, requireAuth, asyncHandler, config, logAuditEvent } = context;

  app.get(
    "/drawings/:id/guest-capabilities",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const [board, instance] = await Promise.all([
        getBoardGuestCapabilityPolicy(prisma, id),
        getInstanceGuestCapabilities(prisma),
      ]);

      return res.json({ board, instance, effective: combineGuestCapabilities(instance, board) });
    }),
  );

  app.put(
    "/drawings/:id/guest-capabilities",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await controlsDrawing({ prisma, userId: req.user.id, drawingId: id }))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const parsed = guestCapabilityToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation error",
          message: "Invalid guest capability payload",
        });
      }

      const [board, instance] = await Promise.all([
        setBoardGuestCapabilityPolicy(prisma, id, parsed.data),
        getInstanceGuestCapabilities(prisma),
      ]);

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_guest_capabilities_updated",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: id, ...board },
        });
      }

      return res.json({ board, instance, effective: combineGuestCapabilities(instance, board) });
    }),
  );
};
