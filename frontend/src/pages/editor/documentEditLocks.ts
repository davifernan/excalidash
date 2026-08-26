import type { Socket } from "socket.io-client";
import {
  collaborationEvents,
  documentEditLockSnapshotSchema,
  publicDocumentEditLockSchema,
  type PublicDocumentEditLock as DocumentEditLock,
} from "@excalidash/domain/collaboration";

export const DOCUMENT_EDIT_LOCK_COMMAND_EVENT = collaborationEvents.documentEditLockCommand;
const DOCUMENT_EDIT_LOCK_EVENT = collaborationEvents.documentEditLockUpdate;
const DOCUMENT_EDIT_LOCK_GRANTED_EVENT = collaborationEvents.documentEditLockGranted;
export type { PublicDocumentEditLock as DocumentEditLock } from "@excalidash/domain/collaboration";

export type DocumentEditLocks = Readonly<Record<string, DocumentEditLock>>;
export type DocumentEditResult =
  { ok: true; token: string } | { ok: false; error: { code: string; message: string } };

export const parseDocumentEditLocks = (
  value: unknown,
  drawingId: string,
): DocumentEditLocks | null => {
  const parsed = documentEditLockSnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.drawingId !== drawingId) return null;
  const snapshot = parsed.data;
  const locks: Record<string, DocumentEditLock> = {};
  for (const value of snapshot.locks) {
    const parsedLock = publicDocumentEditLockSchema.safeParse(value);
    if (!parsedLock.success) continue;
    const lock = parsedLock.data;
    locks[lock.assetId] = lock;
  }
  return locks;
};

export const bindSocketDocumentEditLocks = ({
  socket,
  drawingId,
  onChange,
}: {
  socket: Socket;
  drawingId: string;
  onChange: (locks: DocumentEditLocks) => void;
}) => {
  const reset = () => onChange({});
  const onSnapshot = (value: unknown) => {
    const locks = parseDocumentEditLocks(value, drawingId);
    if (locks) onChange(locks);
  };
  reset();
  socket.on(DOCUMENT_EDIT_LOCK_EVENT, onSnapshot);
  return {
    reset,
    dispose() {
      socket.off(DOCUMENT_EDIT_LOCK_EVENT, onSnapshot);
    },
  };
};

export const acquireDocumentEditLock = (
  socket: Socket,
  drawingId: string,
  assetId: string,
): Promise<DocumentEditResult> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result: DocumentEditResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      socket.off(DOCUMENT_EDIT_LOCK_GRANTED_EVENT, onGranted);
      resolve(result);
    };
    const onGranted = (value: unknown) => {
      const grant = value as { drawingId?: unknown; assetId?: unknown; token?: unknown };
      if (
        grant?.drawingId === drawingId &&
        grant.assetId === assetId &&
        typeof grant.token === "string"
      ) {
        finish({ ok: true, token: grant.token });
      }
    };
    const timeout = window.setTimeout(
      () =>
        finish({
          ok: false,
          error: { code: "timeout", message: "Could not start Markdown editing. Try again." },
        }),
      5_000,
    );
    socket.on(DOCUMENT_EDIT_LOCK_GRANTED_EVENT, onGranted);
    socket.emit(
      DOCUMENT_EDIT_LOCK_COMMAND_EVENT,
      { drawingId, assetId, action: "acquire" },
      (result?: { ok?: boolean; error?: { code?: string; message?: string } }) => {
        if (result?.ok !== false) return;
        finish({
          ok: false,
          error: {
            code: result.error?.code || "refused",
            message: result.error?.message || "This Markdown file is already being edited.",
          },
        });
      },
    );
  });

export const releaseDocumentEditLock = (
  socket: Socket | null,
  drawingId: string,
  assetId: string,
  token: string,
) => {
  socket?.emit(DOCUMENT_EDIT_LOCK_COMMAND_EVENT, {
    drawingId,
    assetId,
    action: "release",
    token,
  });
};
