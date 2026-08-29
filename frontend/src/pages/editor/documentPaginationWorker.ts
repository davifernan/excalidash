import type { DocumentPaginationRequest } from "@excalidash/domain/documents";

export type { DocumentPaginationRequest } from "@excalidash/domain/documents";

export type DocumentPaginationResponse =
  { ok: true; pages: string[] } | { ok: false; error: string };

const abortError = () => new DOMException("Document pagination was cancelled.", "AbortError");

/**
 * Run the deterministic document pagination contract away from React's UI thread.
 *
 * A worker belongs to one request so an asset change can cancel both the work and
 * its retained 2 MiB source immediately. The worker is always terminated after
 * success, failure, or cancellation.
 */
export const paginateDocumentOffThread = (
  source: string,
  kind: DocumentPaginationRequest["kind"],
  signal?: AbortSignal,
): Promise<string[]> => {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./documentPagination.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };

    worker.onmessage = ({ data }: MessageEvent<DocumentPaginationResponse>) => {
      if (!data.ok) {
        finish();
        reject(new Error(data.error));
      } else {
        finish();
        resolve(data.pages);
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Document pagination worker failed."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ source, kind } satisfies DocumentPaginationRequest);
  });
};
