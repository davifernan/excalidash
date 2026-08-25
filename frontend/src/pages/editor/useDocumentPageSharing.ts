import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  bindSocketDocumentPages,
  DOCUMENT_PAGE_COMMAND_EVENT,
  type DocumentPageController,
  type DocumentPageRequestResult,
  type SharedDocumentPages,
} from "./documentPages";

/**
 * The room's page for every document widget on the board.
 *
 * Asking is all this does. The server decides whether the turn is allowed and
 * sends the result to everyone, so what arrives back is the room's page rather
 * than this client's opinion of it.
 */
export const useDocumentPageSharing = ({
  drawingId,
  socketRef,
}: {
  drawingId: string | undefined;
  socketRef: React.MutableRefObject<Socket | null>;
}): {
  controller: DocumentPageController;
  bind: (socket: Socket) => ReturnType<typeof bindSocketDocumentPages>;
  confirmRoomJoined: (socket: Socket) => void;
} => {
  const [pages, setPages] = useState<SharedDocumentPages>({});
  const pendingRequestCancelsRef = useRef(new Set<() => void>());
  const confirmedRoomSocketRef = useRef<Socket | null>(null);
  const roomJoinWaitersRef = useRef(new Set<() => void>());

  useEffect(
    () => () => {
      for (const cancel of pendingRequestCancelsRef.current) cancel();
      pendingRequestCancelsRef.current.clear();
      roomJoinWaitersRef.current.clear();
      confirmedRoomSocketRef.current = null;
    },
    [drawingId],
  );

  const confirmRoomJoined = useCallback(
    (socket: Socket) => {
      if (socketRef.current !== socket || !socket.connected) return;
      confirmedRoomSocketRef.current = socket;
      for (const notify of [...roomJoinWaitersRef.current]) notify();
    },
    [socketRef],
  );

  const requestPage = useCallback(
    (elementId: string, page: number): Promise<DocumentPageRequestResult> => {
      const socket = socketRef.current;
      if (!drawingId || !socket) {
        return Promise.resolve({
          ok: false,
          error: { code: "not-connected", message: "Document page sharing is not connected" },
        });
      }
      const activeSocket = socket;
      return new Promise((resolve) => {
        let settled = false;
        let retryTimeout: number | null = null;
        let waitingForRoom = false;

        const clearRetry = () => {
          if (retryTimeout === null) return;
          window.clearTimeout(retryTimeout);
          retryTimeout = null;
        };
        const cleanup = () => {
          clearRetry();
          activeSocket.off("disconnect", onDisconnect);
          roomJoinWaitersRef.current.delete(onRoomJoined);
          pendingRequestCancelsRef.current.delete(cancel);
        };
        const finish = (result: DocumentPageRequestResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const cancel = () =>
          finish({
            ok: false,
            error: { code: "not-connected", message: "Document page sharing is not connected" },
          });
        const waitUntilRoomJoined = () => {
          if (settled || waitingForRoom) return;
          waitingForRoom = true;
          roomJoinWaitersRef.current.add(onRoomJoined);
        };
        const scheduleRetry = () => {
          clearRetry();
          retryTimeout = window.setTimeout(send, 5_000);
        };
        const acknowledge = (response?: DocumentPageRequestResult) => {
          if (!response) {
            finish({
              ok: false,
              error: { code: "invalid-response", message: "Document page response was invalid" },
            });
            return;
          }
          finish(response);
        };
        function send() {
          if (settled) return;
          if (
            !activeSocket.connected ||
            socketRef.current !== activeSocket ||
            confirmedRoomSocketRef.current !== activeSocket
          ) {
            clearRetry();
            waitUntilRoomJoined();
            return;
          }
          activeSocket.emit(
            DOCUMENT_PAGE_COMMAND_EVENT,
            { drawingId, elementId, page },
            acknowledge,
          );
          scheduleRetry();
        }
        function onRoomJoined() {
          waitingForRoom = false;
          roomJoinWaitersRef.current.delete(onRoomJoined);
          send();
        }
        function onDisconnect() {
          clearRetry();
          // Socket.IO only reconnects automatically while `active` is true.
          // Collaboration-effect cleanup calls socket.disconnect(), which
          // makes this instance permanently inactive before a replacement is
          // created. Do not park a request on a connect event that can never
          // fire; finish it so the widget releases its pending state.
          if (activeSocket.active === false) {
            cancel();
            return;
          }
          waitUntilRoomJoined();
        }

        pendingRequestCancelsRef.current.add(cancel);
        activeSocket.on("disconnect", onDisconnect);
        send();
      });
    },
    [drawingId, socketRef],
  );

  const bind = useCallback(
    (socket: Socket) => {
      const binding = bindSocketDocumentPages({
        socket,
        drawingId: drawingId || "",
        onChange: setPages,
      });
      return {
        ...binding,
        reset() {
          if (confirmedRoomSocketRef.current === socket) confirmedRoomSocketRef.current = null;
          binding.reset();
        },
      };
    },
    [drawingId],
  );

  return { controller: { pages, requestPage }, bind, confirmRoomJoined };
};
