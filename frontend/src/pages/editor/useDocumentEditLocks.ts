import { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import type { Socket } from "socket.io-client";
import {
  acquireDocumentEditLock,
  bindSocketDocumentEditLocks,
  releaseDocumentEditLock,
  type DocumentEditLocks,
  type DocumentEditResult,
} from "./documentEditLocks";

export type DocumentEditController = {
  locks: DocumentEditLocks;
  acquire: (assetId: string) => Promise<DocumentEditResult>;
  release: (assetId: string, token: string) => void;
};

const sameLocks = (left: DocumentEditLocks, right: DocumentEditLocks) => {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id) =>
      left[id] && right[id]
        ? left[id].assetId === right[id].assetId &&
          left[id].presenceId === right[id].presenceId &&
          left[id].ownerName === right[id].ownerName
        : left[id] === right[id],
    )
  );
};

export const useDocumentEditLocks = ({
  drawingId,
  socketRef,
}: {
  drawingId?: string;
  socketRef: MutableRefObject<Socket | null>;
}) => {
  const [locks, setLocks] = useState<DocumentEditLocks>({});

  const acquire = useCallback(
    (assetId: string): Promise<DocumentEditResult> => {
      const socket = socketRef.current;
      if (!drawingId || !socket?.connected) {
        return Promise.resolve({
          ok: false,
          error: { code: "not-connected", message: "Markdown editing is not connected." },
        });
      }
      return acquireDocumentEditLock(socket, drawingId, assetId);
    },
    [drawingId, socketRef],
  );

  const release = useCallback(
    (assetId: string, token: string) =>
      releaseDocumentEditLock(socketRef.current, drawingId || "", assetId, token),
    [drawingId, socketRef],
  );

  const bind = useCallback(
    (socket: Socket) =>
      bindSocketDocumentEditLocks({
        socket,
        drawingId: drawingId || "",
        onChange: (next) => setLocks((current) => (sameLocks(current, next) ? current : next)),
      }),
    [drawingId],
  );

  return { controller: { locks, acquire, release } satisfies DocumentEditController, bind };
};
