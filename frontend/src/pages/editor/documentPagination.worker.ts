import {
  documentPaginationRequestSchema,
  paginateDocumentSource,
} from "@excalidash/domain/documents";
import type {
  DocumentPaginationRequest,
  DocumentPaginationResponse,
} from "./documentPaginationWorker";

self.onmessage = ({ data }: MessageEvent<DocumentPaginationRequest>) => {
  let response: DocumentPaginationResponse;
  try {
    const request = documentPaginationRequestSchema.parse(data);
    response = {
      ok: true,
      pages: paginateDocumentSource(request.source, request.kind, request.budget),
    };
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : "Document pagination failed.",
    };
  }
  self.postMessage(response);
};
