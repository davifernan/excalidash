import type { PrismaClient } from "../generated/client";
import type { Socket } from "socket.io";
import type { DrawingPrincipal } from "../authz/sharing";
import { logger } from "../logger";

type CredentialGuardDeps = {
  prisma: PrismaClient;
  connectedSockets: Map<string, Socket>;
  principals: Map<string, DrawingPrincipal>;
  removeFromDrawing: (socket: Socket, reason: string) => Promise<void>;
  disconnectApiKey: (apiKeyId: string) => Promise<void>;
};

export const createSocketCredentialGuard = ({
  prisma,
  connectedSockets,
  principals,
  removeFromDrawing,
  disconnectApiKey,
}: CredentialGuardDeps) => {
  const disconnectInactiveUserSockets = async (userId: string) => {
    const candidates = Array.from(connectedSockets.values()).filter(
      (socket) => principals.get(socket.id)?.userId === userId,
    );
    await Promise.all(
      candidates.map(async (socket) => {
        connectedSockets.delete(socket.id);
        await removeFromDrawing(socket, "account-inactive");
        principals.delete(socket.id);
        socket.emit("error", {
          code: "account-inactive",
          message: "User account is inactive",
        });
        socket.disconnect(true);
      }),
    );
  };

  const verifyRegisteredSocket = async (socket: Socket): Promise<boolean> => {
    const principal = principals.get(socket.id);
    if (!principal || principal.allowInactive) {
      return connectedSockets.get(socket.id) === socket;
    }
    try {
      const account = await prisma.user.findUnique({
        where: { id: principal.userId },
        select: { isActive: true },
      });
      if (!account?.isActive) {
        await disconnectInactiveUserSockets(principal.userId);
        return false;
      }
      if (principal.apiKey) {
        const currentApiKey = await prisma.apiKey.findUnique({
          where: { id: principal.apiKey.id },
          select: { id: true, revokedAt: true },
        });
        if (!currentApiKey || currentApiKey.revokedAt) {
          await disconnectApiKey(principal.apiKey.id);
          return false;
        }
      }
      return connectedSockets.get(socket.id) === socket;
    } catch (error) {
      logger.error("Final socket credential verification failed", { error });
      connectedSockets.delete(socket.id);
      principals.delete(socket.id);
      socket.emit("error", {
        code: "authentication-failed",
        message: "Authentication failed",
      });
      socket.disconnect(true);
      return false;
    }
  };

  return { disconnectInactiveUserSockets, verifyRegisteredSocket };
};
