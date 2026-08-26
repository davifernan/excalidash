import { useCallback, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { Socket } from "socket.io-client";
import {
  acquireDocumentEditLock,
  bindSocketDocumentEditLocks,
  releaseDocumentEditLock,
  type DocumentEditLocks,
  type DocumentEditResult,
} from "./documentEditLocks";
import {
  bindSocketDocumentEditDrafts,
  createDocumentEditDraftPublisher,
  type DocumentEditDraftPublisher,
  type DocumentEditDrafts,
} from "./documentEditDrafts";

export type DocumentEditController = {
  locks: DocumentEditLocks;
  drafts: DocumentEditDrafts;
  acquire: (assetId: string) => Promise<DocumentEditResult>;
  release: (assetId: string, token: string) => void;
  beginDraft: (assetId: string, token: string, content: string) => void;
  updateDraft: (assetId: string, content: string) => void;
  cancelDraft: (assetId: string) => void;
  endDraft: (assetId: string) => void;
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
  const [drafts, setDrafts] = useState<DocumentEditDrafts>({});
  const publishersRef = useRef(new Map<string, DocumentEditDraftPublisher>());

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
    (socket: Socket) => {
      const lockBinding = bindSocketDocumentEditLocks({
        socket,
        drawingId: drawingId || "",
        onChange: (next) => {
          setLocks((current) => (sameLocks(current, next) ? current : next));
          setDrafts((current) => {
            const entries = Object.entries(current).filter(([assetId]) => Boolean(next[assetId]));
            return entries.length === Object.keys(current).length
              ? current
              : Object.fromEntries(entries);
          });
        },
      });
      const draftBinding = bindSocketDocumentEditDrafts({
        socket,
        drawingId: drawingId || "",
        onChange: (update) => setDrafts(update),
      });
      return {
        reset() {
          lockBinding.reset();
          draftBinding.reset();
        },
        dispose() {
          lockBinding.dispose();
          draftBinding.dispose();
          for (const publisher of publishersRef.current.values()) publisher.dispose();
          publishersRef.current.clear();
        },
      };
    },
    [drawingId],
  );

  const beginDraft = useCallback(
    (assetId: string, token: string, content: string) => {
      const socket = socketRef.current;
      if (!drawingId || !socket?.connected) return;
      publishersRef.current.get(assetId)?.dispose();
      publishersRef.current.set(
        assetId,
        createDocumentEditDraftPublisher({ socket, drawingId, assetId, token, content }),
      );
    },
    [drawingId, socketRef],
  );

  const updateDraft = useCallback((assetId: string, content: string) => {
    publishersRef.current.get(assetId)?.update(content);
  }, []);

  const cancelDraft = useCallback((assetId: string) => {
    publishersRef.current.get(assetId)?.cancel();
    publishersRef.current.delete(assetId);
  }, []);

  const endDraft = useCallback((assetId: string) => {
    publishersRef.current.get(assetId)?.dispose();
    publishersRef.current.delete(assetId);
  }, []);

  return {
    controller: {
      locks,
      drafts,
      acquire,
      release,
      beginDraft,
      updateDraft,
      cancelDraft,
      endDraft,
    } satisfies DocumentEditController,
    bind,
  };
};
