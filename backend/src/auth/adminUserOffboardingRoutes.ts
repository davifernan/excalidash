import type { Request, Response } from "express";
import { Prisma } from "../generated/client";
import { logger } from "../logger";
import { disconnectApiKeySockets, recheckActiveUserSockets } from "../server/socketRevocation";
import { logAuditEvent } from "../utils/audit";
import type { RegisterAdminRoutesDeps } from "./adminRoutes";
import { offboardUserAndTransferBoards, UserOffboardingError } from "./userOffboarding";

export const registerAdminUserOffboardingRoutes = (deps: RegisterAdminRoutesDeps) => {
  const {
    router,
    prisma,
    requireAuth,
    ensureAuthEnabled,
    requireAdmin,
    requireCsrf,
    countActiveAdmins,
    config,
  } = deps;

  router.post("/users/:id/offboard", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireCsrf(req, res)) return;
      if (!requireAdmin(req, res)) return;

      const userId = String(req.params.id || "").trim();
      if (!userId) {
        return res.status(400).json({ error: "Bad request", message: "Invalid user id" });
      }
      if (userId === req.user.id) {
        return res.status(409).json({
          error: "Conflict",
          message: "You cannot permanently delete your own account",
        });
      }

      const useCompanyArchive = req.body?.transferTo === "company-archive";
      const successorUserId =
        typeof req.body?.transferToUserId === "string" ? req.body.transferToUserId.trim() : null;
      if (useCompanyArchive === Boolean(successorUserId)) {
        return res.status(400).json({
          error: "Bad request",
          message: "Choose exactly one board transfer destination",
        });
      }

      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, isActive: true },
      });
      if (!target) {
        return res.status(404).json({ error: "Not found", message: "User not found" });
      }
      if (target.role === "ADMIN" && target.isActive && (await countActiveAdmins()) <= 1) {
        return res.status(409).json({
          error: "Conflict",
          message: "There must be at least one active admin",
        });
      }

      const result = await offboardUserAndTransferBoards({
        prisma,
        userId,
        successorUserId,
        useCompanyArchive,
      });
      await Promise.all([
        recheckActiveUserSockets(userId),
        ...result.revokedApiKeyIds.map(disconnectApiKeySockets),
      ]);

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "admin_user_personal_data_deleted",
          resource: "user-offboarding",
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          // Deliberately omit the erased user id. Keeping it here would
          // recreate the personal audit record this operation just removed.
          details: {
            transferredDrawings: result.transferredDrawings,
            usedCompanyArchive: useCompanyArchive,
          },
        });
      }

      return res.json({
        deleted: true,
        successorUserId: result.successorUserId,
        transferredDrawings: result.transferredDrawings,
      });
    } catch (error) {
      if (error instanceof UserOffboardingError) {
        return res.status(error.status).json({
          error:
            error.status === 404 ? "Not found" : error.status === 400 ? "Bad request" : "Conflict",
          message: error.message,
        });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return res.status(409).json({
          error: "Conflict",
          message: "The company archive account could not be reserved",
        });
      }
      logger.error("User offboarding error", { error });
      return res.status(500).json({
        error: "Internal server error",
        message: "Failed to permanently delete user data",
      });
    }
  });
};
