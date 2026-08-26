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

  it("runs the production worker handler and returns the real default-budget page count", async () => {
    const postMessage = vi.fn<(response: DocumentPaginationResponse) => void>();
    const workerScope: {
      onmessage?: (event: MessageEvent<DocumentPaginationRequest>) => void;
      postMessage: typeof postMessage;
    } = { postMessage };
    vi.stubGlobal("self", workerScope);
    vi.resetModules();

    // Importing the actual worker module installs the same handler Vite runs in
    // the browser. No Worker client or handwritten response stands in for it.
    await import("./documentPagination.worker");
    expect(
      workerScope.onmessage,
      "the production worker must install its message handler",
    ).toBeTypeOf("function");

    workerScope.onmessage?.(
      new MessageEvent("message", {
        data: { source: "x".repeat(50_000), kind: "TEXT" },
      }),
    );

    expect(postMessage).toHaveBeenCalledOnce();
    const response = postMessage.mock.calls[0][0];
    expect(response.ok, "the production worker must accept a valid pagination request").toBe(true);
    if (!response.ok) throw new Error(response.error);
    expect(
      response.pages,
      "the production worker must return all three 50,000-character pages",
    ).toHaveLength(3);
  });

  it("posts source to a module worker and releases it after the result", async () => {
    const result = paginateDocumentOffThread("one\ntwo", "TEXT");
    const worker = FakeWorker.instances[0];

    expect(worker.options).toEqual({ type: "module" });
    expect(worker.postMessage).toHaveBeenCalledWith({ source: "one\ntwo", kind: "TEXT" });
    worker.onmessage?.(
      new MessageEvent("message", { data: { ok: true, pages: ["one\n", "two"] } }),
    );

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
