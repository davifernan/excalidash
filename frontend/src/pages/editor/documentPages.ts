import type { Socket } from "socket.io-client";
import {
  collaborationEvents,
  documentPageUpdateEntrySchema,
  documentPageSnapshotSchema,
  type SharedDocumentPage,
} from "@excalidash/domain/collaboration";

const DOCUMENT_PAGE_EVENT = collaborationEvents.documentPageUpdate;
export const DOCUMENT_PAGE_COMMAND_EVENT = collaborationEvents.documentPageCommand;

export type { SharedDocumentPage } from "@excalidash/domain/collaboration";
/** Authoritative page and revision for each document widget, by element id. */
export type SharedDocumentPages = Readonly<Record<string, SharedDocumentPage>>;

export type DocumentPageRequestResult =
  { ok: true } | { ok: false; error: { code: string; message: string } };

export type DocumentPageController = {
  pages: SharedDocumentPages;
  /**
   * Ask the room to turn a widget to a page. Nothing changes here — the server
   * decides and sends the result back, so a refused turn simply never happens
   * rather than leaving this client showing a page nobody else is on.
   */
  requestPage: (elementId: string, page: number) => Promise<DocumentPageRequestResult>;
};

/**
 * Read a page update from the server.
 *
 * Updates arrive either as the whole board on joining or as a single widget
 * after somebody turned a page, so the result is always merged rather than
 * treated as the complete picture.
 */
export const parseDocumentPageUpdate = (
  value: unknown,
  drawingId: string,
): SharedDocumentPages | null => {
  const parsed = documentPageSnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.drawingId !== drawingId) return null;
  const data = parsed.data;
  const pages: Record<string, SharedDocumentPage> = {};
  for (const value of data.pages) {
    const parsedEntry = documentPageUpdateEntrySchema.safeParse(value);
    if (!parsedEntry.success) continue;
    const { elementId, page, revision } = parsedEntry.data;
    pages[elementId] = { page, revision };
  }
  return pages;
};

export const bindSocketDocumentPages = ({
  socket,
  drawingId,
  onChange,
}: {
  socket: Socket;
  drawingId: string;
  onChange: (update: (current: SharedDocumentPages) => SharedDocumentPages) => void;
}) => {
  const reset = () => onChange(() => ({}));
  const onUpdate = (value: unknown) => {
    const pages = parseDocumentPageUpdate(value, drawingId);
    if (pages) {
      onChange((current) => {
        const next = { ...current };
        for (const [elementId, page] of Object.entries(pages)) {
          if (!next[elementId] || page.revision > next[elementId].revision) {
            next[elementId] = page;
          }
        }
        return next;
      });
    }
  };

  reset();
  socket.on(DOCUMENT_PAGE_EVENT, onUpdate);
  return {
    reset,
    dispose() {
      socket.off(DOCUMENT_PAGE_EVENT, onUpdate);
    },
  };
};
