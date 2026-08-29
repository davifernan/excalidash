import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paginateDocumentOffThread,
  type DocumentPaginationRequest,
  type DocumentPaginationResponse,
} from "./documentPaginationWorker";

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(
    readonly scriptUrl: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }
}

describe("document pagination worker client", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["TEXT", "MARKDOWN"] as const)(
    "runs the production Worker handler for 50,000 uninterrupted %s characters",
    async (kind) => {
      const postMessage = vi.fn<(response: DocumentPaginationResponse) => void>();
      const workerScope: {
        onmessage?: (event: MessageEvent<DocumentPaginationRequest>) => void;
        postMessage: typeof postMessage;
      } = { postMessage };
      vi.stubGlobal("self", workerScope);
      vi.resetModules();

      await import("./documentPagination.worker");
      workerScope.onmessage?.(
        new MessageEvent("message", { data: { source: "x".repeat(50_000), kind } }),
      );

      const responses = postMessage.mock.calls.map(([response]) => response);
      expect(responses.at(-1)).toEqual({ ok: true, type: "complete" });
      expect(responses.filter((response) => response.ok && response.type === "page")).toHaveLength(
        3,
      );
    },
  );

  it("rejects an invalid worker message before pagination", async () => {
    const postMessage = vi.fn<(response: DocumentPaginationResponse) => void>();
    const workerScope: {
      onmessage?: (event: MessageEvent<unknown>) => void;
      postMessage: typeof postMessage;
    } = { postMessage };
    vi.stubGlobal("self", workerScope);
    vi.resetModules();

    await import("./documentPagination.worker");
    workerScope.onmessage?.(new MessageEvent("message", { data: { source: 42, kind: "TEXT" } }));

    expect(postMessage).toHaveBeenCalledWith({
      ok: false,
      error: "Invalid document pagination request.",
    });
  });

  it("posts source to a module worker and releases it after the result", async () => {
    const result = paginateDocumentOffThread("one\ntwo", "TEXT");
    const worker = FakeWorker.instances[0];

    expect(worker.options).toEqual({ type: "module" });
    expect(worker.postMessage).toHaveBeenCalledWith({ source: "one\ntwo", kind: "TEXT" });
    worker.onmessage?.(
      new MessageEvent("message", { data: { ok: true, type: "page", page: "one\n" } }),
    );
    worker.onmessage?.(
      new MessageEvent("message", { data: { ok: true, type: "page", page: "two" } }),
    );
    worker.onmessage?.(new MessageEvent("message", { data: { ok: true, type: "complete" } }));

    await expect(result).resolves.toEqual(["one\n", "two"]);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates pending work when the owning widget cancels", async () => {
    const controller = new AbortController();
    const result = paginateDocumentOffThread("large source", "MARKDOWN", controller.signal);
    const worker = FakeWorker.instances[0];

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("reports a worker construction failure as a rejected request", async () => {
    const failure = new Error("worker blocked");
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw failure;
        }
      },
    );

    await expect(paginateDocumentOffThread("source", "TEXT")).rejects.toBe(failure);
  });
});
