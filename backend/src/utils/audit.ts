/**
 * Audit logging utility for security events
 */
import { prisma } from "../db/prisma";
import { logger } from "../logger";
import { config } from "../config";

let prismaProvider: () => typeof prisma = () => prisma;

export const setAuditPrismaProvider = (provider: (() => typeof prisma) | null): void => {
  prismaProvider = provider ?? (() => prisma);
};

export interface AuditLogData {
  userId?: string;
  action: string;
  resource?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}

export interface AuditLogResult {
  id: string;
  userId: string | null;
  action: string;
  resource: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  details: unknown | null;
  createdAt: Date;
  user: { id: string; email: string; name: string } | null;
}

/**
 * Log a security event to the audit log
 * This should be called for important security-related actions
 * Gracefully handles missing audit log table (feature disabled)
 */
export const logAuditEvent = async (data: AuditLogData): Promise<void> => {
  try {
    // Dynamic, not the top-level `config` import: tests set
    // ENABLE_AUDIT_LOGGING at runtime, after config.ts has already been
    // imported (and its environment snapshot cached) elsewhere in the module
    // graph. A fresh `import()` here still resolves to Node's one cached
    // module instance in production, so this changes nothing outside tests.
    const { config: liveConfig } = await import("../config");
    if (!liveConfig.enableAuditLogging) {
      return; // Feature disabled, silently skip
    }

    await prismaProvider().auditLog.create({
      data: {
        userId: data.userId || null,
        action: data.action,
        resource: data.resource || null,
        ipAddress: data.ipAddress || null,
        userAgent: data.userAgent || null,
        details: data.details ? JSON.stringify(data.details) : null,
      },
    });
  } catch (error) {
    if (config.nodeEnv === "development") {
      logger.debug("audit logging skipped (feature disabled or table missing)", { error });
    }
  }
};

/**
 * Get audit logs for a user (or all users if userId is not provided)
 * Returns empty array if audit logging is disabled or table doesn't exist
 */
export const getAuditLogs = async (
  userId?: string,
  limit: number = 100,
): Promise<AuditLogResult[]> => {
  try {
    const { config: liveConfig } = await import("../config");
    if (!liveConfig.enableAuditLogging) {
      return []; // Feature disabled, return empty array
    }

    const logs = await prismaProvider().auditLog.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return logs.map((log) => ({
      ...log,
      details: (() => {
        if (!log.details) return null;
        try {
          return JSON.parse(log.details) as unknown;
        } catch {
          return null;
        }
      })(),
    }));
  } catch (error) {
    if (config.nodeEnv === "development") {
      logger.debug("failed to retrieve audit logs (feature disabled or table missing)", { error });
    }
    return [];
  }
};
