import type { Server, Socket } from "socket.io";
import {
  collaborationEvents,
  type DocumentPageEntry as DocumentPage,
} from "@excalidash/domain/collaboration";
import { DOCUMENT_WIDGET_LIMIT, syncDrawingDocumentState } from "../assets/documentWidgetState";
import { parseDrawingId } from "./socketProtocol";
import {
  registerAuthorizedRoomEvent,
  type RoomEventError,
  type RoomEventPayload,
  type RoomEventResult,
} from "./socketRoomEvent";
import { logger } from "../logger";

export const DOCUMENT_PAGE_EVENT = collaborationEvents.documentPageUpdate;
const DOCUMENT_PAGE_COMMAND_EVENT = collaborationEvents.documentPageCommand;

export const DOCUMENT_PAGE_LIMITS = {
  commandsPerMinute: 120,
  widgetsPerDrawing: DOCUMENT_WIDGET_LIMIT,
  maxPage: 2_147_483_647,
} as const;

const ELEMENT_ID = /^[\w-]{1,64}$/;

export type { DocumentPageEntry as DocumentPage } from "@excalidash/domain/collaboration";
export type DocumentPageSnapshot = { drawingId: string; pages: DocumentPage[] };

export type DocumentPageCommand = RoomEventPayload & {
  elementId: string;
  page: number;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

export const parseDocumentPageCommand = (value: unknown): DocumentPageCommand | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId) return null;
  const { elementId, page } = data;
  if (typeof elementId !== "string" || !ELEMENT_ID.test(elementId)) return null;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
  if (page > DOCUMENT_PAGE_LIMITS.maxPage) return null;
  return { drawingId, elementId, page };
};

const refusal = (code: string, message: string): { error: RoomEventError } => ({
  error: { code, message },
});

/**
 * The room's shared page for every document widget on a board.
 *
 * The client asks; the server decides. Nothing here believes the sender about
 * which document a widget shows or how many pages it has: the asset has to be
 * attached to this very board, and the page has to exist. What goes out to the
 * room is the server's own record, never the request that caused it.
 */
export const createDocumentPageManager = ({
  io,
  prisma,
  resolvePageCount,
}: {
  io: Pick<Server, "to">;
  prisma: any;
  resolvePageCount?: (assetId: string) => Promise<number | null>;
}) => {
  const snapshot = async (
    drawingId: string,
    correlationId?: string,
  ): Promise<DocumentPageSnapshot> => {
    const reconcile = async (tx: any) => {
      const drawing = await tx.drawing.findUnique({
        where: { id: drawingId },
        select: { elements: true },
      });
      if (!drawing) return [];
      // Production rows always carry serialized elements. Socket-only test
      // doubles often model access fields alone; they can still exercise the
      // snapshot read without pretending to implement scene reconciliation.
      if (typeof drawing.elements === "string") {
        const elements = JSON.parse(drawing.elements);
        if (!Array.isArray(elements)) throw new Error("Drawing elements are not an array");
        logger.warn("NIL-601 diagnostic: snapshot reconcile reading persisted elements", {
          drawingId,
          correlationId,
          elementCount: elements.length,
          embeddableCount: elements.filter((e: any) => e?.type === "embeddable").length,
        });
        await syncDrawingDocumentState(tx, drawingId, elements, { correlationId });
      }
      if (!tx.documentPageView?.findMany) return [];
      return tx.documentPageView.findMany({
        where: { drawingId },
        select: { elementId: true, assetId: true, page: true, revision: true },
        take: DOCUMENT_PAGE_LIMITS.widgetsPerDrawing,
      });
    };
    const rows =
      typeof prisma.$transaction === "function"
        ? await prisma.$transaction(reconcile)
        : await reconcile(prisma);
    return { drawingId, pages: rows };
  };

  const set = async (
    payload: DocumentPageCommand,
    correlationId?: string,
  ): Promise<RoomEventResult> => {
    const widget = await prisma.documentPageView.findUnique({
      where: {
        drawingId_elementId: { drawingId: payload.drawingId, elementId: payload.elementId },
      },
      select: {
        assetId: true,
        page: true,
        asset: { select: { pageCount: true, status: true } },
      },
    });
    if (!widget) {
      const existing = await prisma.documentPageView.findMany({
        where: { drawingId: payload.drawingId },
        select: { elementId: true, assetId: true },
      });
      logger.warn("NIL-601 diagnostic: document widget not found for page set", {
        drawingId: payload.drawingId,
        correlationId,
        soughtElementId: payload.elementId,
        existingRows: existing,
      });
      return refusal("document-widget-not-found", "Document widget is not part of this board");
    }
    if (widget.asset.status !== "READY") {
      return refusal("document-unavailable", "Document is not ready");
    }
    let pageCount = widget.asset.pageCount;
    if (typeof pageCount !== "number" && resolvePageCount) {
      try {
        pageCount = await resolvePageCount(widget.assetId);
      } catch (error) {
        logger.error("Document page count derivation failed", {
          drawingId: payload.drawingId,
          assetId: widget.assetId,
          error,
        });
      }
    }
    if (typeof pageCount !== "number") {
      return refusal("document-page-count-unavailable", "Document page count is unavailable");
    }
    if (payload.page > pageCount) {
      return refusal("document-page-out-of-range", "Document page does not exist");
    }
    if (widget.page === payload.page) {
      // Nothing moved. Skip the write and the broadcast rather than making
      // every reader repaint because somebody clicked a disabled-looking arrow.
      return;
    }

    let page: DocumentPage;
    try {
      page = await prisma.documentPageView.update({
        where: {
          drawingId_elementId: { drawingId: payload.drawingId, elementId: payload.elementId },
        },
        data: { page: payload.page, revision: { increment: 1 } },
        select: { elementId: true, assetId: true, page: true, revision: true },
      });
    } catch (error: any) {
      if (error?.code === "P2025") {
        const existing = await prisma.documentPageView.findMany({
          where: { drawingId: payload.drawingId },
          select: { elementId: true, assetId: true },
        });
        logger.warn("NIL-601 diagnostic: document widget vanished between lookup and update", {
          drawingId: payload.drawingId,
          correlationId,
          soughtElementId: payload.elementId,
          existingRows: existing,
        });
        return refusal("document-widget-not-found", "Document widget is not part of this board");
      }
      throw error;
    }

    io.to(roomName(payload.drawingId)).emit(DOCUMENT_PAGE_EVENT, {
      drawingId: payload.drawingId,
      pages: [page],
    } satisfies DocumentPageSnapshot);
  };

  return { set, snapshot };
};

export type DocumentPageManager = ReturnType<typeof createDocumentPageManager>;

export const registerDocumentPageRoomEvent = ({
  socket,
  pages,
  requireAccess,
}: {
  socket: Socket;
  pages: DocumentPageManager;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
}): void => {
  registerAuthorizedRoomEvent({
    socket,
    event: DOCUMENT_PAGE_COMMAND_EVENT,
    limit: DOCUMENT_PAGE_LIMITS.commandsPerMinute,
    windowMs: 60_000,
    parse: parseDocumentPageCommand,
    requireAccess,
    // Turning the page for everybody is a change to what the room sees, so it
    // takes the same right as changing anything else on the board. A visitor
    // who may only look still pages through the document on their own screen.
    requireEdit: true,
    handle: (payload) => pages.set(payload, socket.id),
  });
};
