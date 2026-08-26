import type { Socket } from "socket.io-client";
import { createTrailingPublisher, type TrailingPublisher } from "./trailingPublisher";

export const DOCUMENT_EDIT_DRAFT_COMMAND_EVENT = "document-edit-draft-command";
const DOCUMENT_EDIT_DRAFT_EVENT = "document-edit-draft-update";

export type DocumentEditDraft = Readonly<{
  assetId: string;
  presenceId: string;
  revision: number;
  content: string;
}>;

export type DocumentEditDrafts = Readonly<Record<string, DocumentEditDraft>>;

type TextPatch = { start: number; deleteCount: number; text: string };

export const createTextPatch = (before: string, after: string): TextPatch => {
  let start = 0;
  const shared = Math.min(before.length, after.length);
  while (start < shared && before[start] === after[start]) start += 1;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    start,
    deleteCount: beforeEnd - start,
    text: after.slice(start, afterEnd),
  };
};

const applyPatch = (content: string, patch: TextPatch): string | null => {
  if (
    !Number.isSafeInteger(patch.start) ||
    !Number.isSafeInteger(patch.deleteCount) ||
    patch.start < 0 ||
    patch.deleteCount < 0 ||
    patch.start > content.length ||
    patch.deleteCount > content.length - patch.start ||
    typeof patch.text !== "string"
  ) {
    return null;
  }
  return `${content.slice(0, patch.start)}${patch.text}${content.slice(
    patch.start + patch.deleteCount,
  )}`;
};

export const bindSocketDocumentEditDrafts = ({
  socket,
  drawingId,
  onChange,
}: {
  socket: Socket;
  drawingId: string;
  onChange: (update: (current: DocumentEditDrafts) => DocumentEditDrafts) => void;
}) => {
  const onUpdate = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const data = value as Record<string, any>;
    if (data.drawingId !== drawingId) return;

    if (Array.isArray(data.drafts)) {
      const next: Record<string, DocumentEditDraft> = {};
      for (const draft of data.drafts) {
        if (
          draft &&
          typeof draft.assetId === "string" &&
          typeof draft.presenceId === "string" &&
          Number.isSafeInteger(draft.revision) &&
          draft.revision >= 1 &&
          typeof draft.content === "string"
        ) {
          next[draft.assetId] = draft;
        }
      }
      onChange(() => next);
      return;
    }

    const assetId = typeof data.assetId === "string" ? data.assetId : null;
    if (!assetId) return;
    if (data.content === null) {
      onChange((current) => {
        if (!current[assetId]) return current;
        const next = { ...current };
        delete next[assetId];
        return next;
      });
      return;
    }

    if (
      typeof data.presenceId !== "string" ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      !data.patch ||
      typeof data.patch !== "object"
    ) {
      return;
    }
    onChange((current) => {
      const previous = current[assetId];
      if (data.revision !== (previous?.revision ?? 0) + 1) return current;
      const content = applyPatch(previous?.content ?? "", data.patch as TextPatch);
      if (content === null) return current;
      return {
        ...current,
        [assetId]: {
          assetId,
          presenceId: data.presenceId,
          revision: data.revision,
          content,
        },
      };
    });
  };

  socket.on(DOCUMENT_EDIT_DRAFT_EVENT, onUpdate);
  return {
    reset: () => onChange(() => ({})),
    dispose: () => socket.off(DOCUMENT_EDIT_DRAFT_EVENT, onUpdate),
  };
};

export type DocumentEditDraftPublisher = {
  update: (content: string) => void;
  cancel: () => void;
  dispose: () => void;
};

export const createDocumentEditDraftPublisher = ({
  socket,
  drawingId,
  assetId,
  token,
  content,
}: {
  socket: Socket;
  drawingId: string;
  assetId: string;
  token: string;
  content: string;
}): DocumentEditDraftPublisher => {
  let sentContent = "";
  let revision = 0;
  const emitPatch = (nextContent: string) => {
    revision += 1;
    const patch = createTextPatch(sentContent, nextContent);
    socket.emit(DOCUMENT_EDIT_DRAFT_COMMAND_EVENT, {
      drawingId,
      assetId,
      token,
      action: "patch",
      revision,
      ...patch,
    });
    sentContent = nextContent;
  };
  const publisher: TrailingPublisher<string> = createTrailingPublisher({ emit: emitPatch });
  publisher.publish(content);

  return {
    update: publisher.publish,
    cancel: () => {
      publisher.dispose();
      socket.emit(DOCUMENT_EDIT_DRAFT_COMMAND_EVENT, {
        drawingId,
        assetId,
        token,
        action: "clear",
      });
    },
    dispose: publisher.dispose,
  };
};
