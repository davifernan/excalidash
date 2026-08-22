import { paginateDocumentSource } from "./documentPagination";
import type {
  DocumentPaginationRequest,
  DocumentPaginationResponse,
} from "./documentPaginationWorker";

self.onmessage = ({ data }: MessageEvent<DocumentPaginationRequest>) => {
  let response: DocumentPaginationResponse;
  try {
    response = { ok: true, pages: paginateDocumentSource(data.source, data.kind) };
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : "Document pagination failed.",
    };
  }
  self.postMessage(response);
};
