import { paginateDocumentSource } from "@excalidash/domain/documents/pagination";
import type {
  DocumentPaginationRequest,
  DocumentPaginationResponse,
} from "./documentPaginationWorker";

/**
 * Keep the worker boundary defensive without instantiating the application's Zod
 * contract for every pagination request. Importing that barrel pulls Zod into this
 * short-lived worker and makes large-document responsiveness depend on its startup.
 */
const isPaginationRequest = (data: unknown): data is DocumentPaginationRequest => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;

  const request = data as Record<string, unknown>;
  return (
    typeof request.source === "string" &&
    (request.kind === "MARKDOWN" || request.kind === "TEXT") &&
    (request.budget === undefined ||
      (typeof request.budget === "number" &&
        Number.isInteger(request.budget) &&
        request.budget > 0))
  );
};

self.onmessage = ({ data }: MessageEvent<unknown>) => {
  let response: DocumentPaginationResponse;
  try {
    if (!isPaginationRequest(data)) {
      throw new Error("Invalid document pagination request.");
    }
    const request = data;
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
