import type { Root } from "hast";

export type DocumentMarkdownRequest = { source: string };
export type DocumentMarkdownResponse = { ok: true; tree: Root } | { ok: false };

const abortError = () => new DOMException("Markdown rendering was cancelled.", "AbortError");

/** Parse the current page away from the UI thread and discard stale work on page changes. */
export const renderMarkdownOffThread = (source: string, signal?: AbortSignal): Promise<Root> => {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./documentMarkdown.worker.ts", import.meta.url), {
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

    worker.onmessage = ({ data }: MessageEvent<DocumentMarkdownResponse>) => {
      finish();
      if (data.ok) resolve(data.tree);
      else reject(new Error("Markdown rendering worker failed."));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Markdown rendering worker failed."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ source } satisfies DocumentMarkdownRequest);
  });
};
