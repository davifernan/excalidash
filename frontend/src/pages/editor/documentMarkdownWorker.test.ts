import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdownOffThread } from "./documentMarkdownWorker";

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

describe("Markdown worker client", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  it("posts only the visible page and releases the worker after the tree arrives", async () => {
    const result = renderMarkdownOffThread("# Visible page");
    const worker = FakeWorker.instances[0];
    const tree = { type: "root", children: [] } as const;

    expect(worker.options).toEqual({ type: "module" });
    expect(worker.postMessage).toHaveBeenCalledWith({ source: "# Visible page" });
    worker.onmessage?.(new MessageEvent("message", { data: { ok: true, tree } }));

    await expect(result).resolves.toEqual(tree);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates stale parsing when the visible page changes", async () => {
    const controller = new AbortController();
    const result = renderMarkdownOffThread("# Old page", controller.signal);
    const worker = FakeWorker.instances[0];

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("does not expose a worker's input-echoing error message", async () => {
    const result = renderMarkdownOffThread("secret marker LEAKME42");
    const worker = FakeWorker.instances[0];

    worker.onerror?.(new ErrorEvent("error", { message: "LEAKME42 is invalid Markdown" }));

    await expect(result).rejects.toThrow("Markdown rendering worker failed.");
    await expect(result).rejects.not.toThrow("LEAKME42");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("preserves the worker error class without exposing document content", async () => {
    const result = renderMarkdownOffThread("secret marker LEAKME42");
    const worker = FakeWorker.instances[0];

    worker.onmessage?.(
      new MessageEvent("message", { data: { ok: false, errorName: "SyntaxError" } }),
    );

    await expect(result).rejects.toMatchObject({
      name: "SyntaxError",
      message: "Markdown rendering worker failed.",
    });
  });
});
