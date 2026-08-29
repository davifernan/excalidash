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
  try {
    if (!isPaginationRequest(data)) {
      throw new Error("Invalid document pagination request.");
    }
    const request = data;
    // A single response with every page structured-clones the whole document
    // back onto the UI thread in one task. Each page is bounded by the
    // pagination budget, so stream them as independent tasks and only commit
    // React state when the explicit completion message arrives.
    for (const page of paginateDocumentSource(request.source, request.kind, request.budget)) {
      self.postMessage({ ok: true, type: "page", page } satisfies DocumentPaginationResponse);
    }
    self.postMessage({ ok: true, type: "complete" } satisfies DocumentPaginationResponse);
  } catch (error) {
    const response: DocumentPaginationResponse = {
      ok: false,
      error: error instanceof Error ? error.message : "Document pagination failed.",
    };
    self.postMessage(response);
  }
};
