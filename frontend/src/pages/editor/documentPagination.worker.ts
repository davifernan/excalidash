import { paginateDocumentSource } from "@excalidash/domain/documents/pagination";
import type {
  DocumentPaginationRequest,
  DocumentPaginationResponse,
} from "./documentPaginationWorker";

self.onmessage = ({ data }: MessageEvent<DocumentPaginationRequest>) => {
  try {
    self.postMessage({
      ok: true,
      pages: paginateDocumentSource(data.source, data.kind, data.budget),
    } satisfies DocumentPaginationResponse);
  } catch (error) {
    const response: DocumentPaginationResponse = {
      ok: false,
      error: error instanceof Error ? error.message : "Document pagination failed.",
    };
    self.postMessage(response);
  }
};
