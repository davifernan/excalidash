import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { paginateDocumentSource as paginateOnServer } from "./documentPagination";
import type {
  DocumentPaginationRequest,
  DocumentPaginationResponse,
} from "../../../frontend/src/pages/editor/documentPaginationWorker";

const uninterruptedSource = "x".repeat(50_000);

const runProductionWorker = async (request: DocumentPaginationRequest) => {
  const postMessage = vi.fn<(response: DocumentPaginationResponse) => void>();
  const workerScope: {
    onmessage?: (event: MessageEvent<DocumentPaginationRequest>) => void;
    postMessage: typeof postMessage;
  } = { postMessage };
  vi.stubGlobal("self", workerScope);
  vi.resetModules();

  const workerModule = process.env.DOCUMENT_PAGINATION_WORKER_MODULE
    ? pathToFileURL(resolve(process.cwd(), process.env.DOCUMENT_PAGINATION_WORKER_MODULE)).href
    : new URL("../../../frontend/src/pages/editor/documentPagination.worker.ts", import.meta.url)
        .href;
  await import(workerModule);
  expect(
    workerScope.onmessage,
    "the production Worker must install its message handler",
  ).toBeTypeOf("function");
  workerScope.onmessage?.(new MessageEvent("message", { data: request }));

  expect(
    postMessage,
    "the production Worker must answer the pagination request",
  ).toHaveBeenCalledOnce();
  const response = postMessage.mock.calls[0][0];
  expect(response.ok, "the production Worker must accept a valid pagination request").toBe(true);
  if (!response.ok) throw new Error(response.error);
  return response.pages;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("document pagination cross-runtime contract", () => {
  it.each(["TEXT", "MARKDOWN"] as const)(
    "returns byte-identical three-page output through the real backend and Worker for 50,000 uninterrupted %s",
    async (kind) => {
      const backendPages = paginateOnServer(uninterruptedSource, kind);
      const workerPages = await runProductionWorker({ source: uninterruptedSource, kind });

      expect(backendPages, "the real backend must produce exactly three pages").toHaveLength(3);
      expect(workerPages, "the real Worker must produce exactly three pages").toHaveLength(3);
      expect(workerPages, "backend and Worker pages must be byte-identical").toEqual(backendPages);
      expect(workerPages.join(""), "pagination must preserve every source byte").toBe(
        uninterruptedSource,
      );
    },
  );
});
