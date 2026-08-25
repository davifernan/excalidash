import { SOCKET_CONNECTION_RECOVERY } from "./socketProtocol";

type OriginCheck = (origin?: string) => boolean;

export const createSocketServerOptions = (
  isAllowedOrigin: OriginCheck,
  maxHttpBufferSize: number,
) => ({
  cors: {
    origin: (origin: string | undefined, callback: (error: null, allowed: boolean) => void) =>
      callback(null, isAllowedOrigin(origin)),
    credentials: true,
  },
  maxHttpBufferSize,
  connectionStateRecovery: SOCKET_CONNECTION_RECOVERY,
});
