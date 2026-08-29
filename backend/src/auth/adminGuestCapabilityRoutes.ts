import { Request, Response } from "express";
import { logger } from "../logger";
import { logAuditEvent } from "../utils/audit";
import { getInstanceGuestCapabilities, setInstanceGuestCapabilities } from "../authz/capabilities";
import type { RegisterAdminRoutesDeps } from "./adminRoutes";
import { guestCapabilityToggleSchema } from "./schemas";

/**
 * The instance-wide ceiling from NIL-615 (NIL-633's admin half). Board-level
 * toggles live in routes/dashboard/guestCapabilityRoutes.ts and go through
 * controlsDrawing instead of requireAdmin -- two different "who may change
 * this" questions over the same two booleans, not one route with two guards.
 */
export const registerAdminGuestCapabilityRoutes = (deps: RegisterAdminRoutesDeps) => {
  const { router, prisma, requireAuth, ensureAuthEnabled, requireAdmin, config, requireCsrf } =
    deps;

  router.get("/guest-capabilities", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireAdmin(req, res)) return;
      const capabilities = await getInstanceGuestCapabilities(prisma);
      res.json({ capabilities });
    } catch (error) {
      logger.error("Get instance guest capabilities error", { error });
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to fetch guest capability settings",
      });
    }
  });

  router.put("/guest-capabilities", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireCsrf(req, res)) return;
      if (!requireAdmin(req, res)) return;
      const parsed = guestCapabilityToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Bad request",
          message: "Invalid guest capability payload",
        });
      }
      const capabilities = await setInstanceGuestCapabilities(prisma, parsed.data);
      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "admin_guest_capabilities_updated",
          resource: "system_config",
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { ...capabilities },
        });
      }
      res.json({ capabilities });
    } catch (error) {
      logger.error("Update instance guest capabilities error", { error });
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to update guest capability settings",
      });
    }
  });
};
