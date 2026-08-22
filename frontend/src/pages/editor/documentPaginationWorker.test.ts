import { beforeEach, describe, expect, it, vi } from "vitest";
import { paginateDocumentOffThread } from "./documentPaginationWorker";

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
