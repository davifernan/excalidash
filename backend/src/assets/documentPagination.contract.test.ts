import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentPaginationRequest } from "@excalidash/domain/documents";
import { paginateDocumentSource as paginateOnServer } from "./documentPagination";

type WorkerResponse = { ok: true; pages: string[] } | { ok: false; error: string };

const paginateThroughProductionWorker = async (
  request: DocumentPaginationRequest,
): Promise<WorkerResponse> => {
  let response: WorkerResponse | undefined;
  const workerScope = {
    postMessage(value: WorkerResponse) {
      response = value;
    },
  } as {
    onmessage?: (event: MessageEvent<DocumentPaginationRequest>) => void;
    postMessage(value: WorkerResponse): void;
  };
  vi.stubGlobal("self", workerScope);
  vi.resetModules();

  await import("../../../frontend/src/pages/editor/documentPagination.worker");
  expect(
    workerScope.onmessage,
    "the browser production worker must install its handler",
  ).toBeTypeOf("function");
  workerScope.onmessage?.({ data: request } as MessageEvent<DocumentPaginationRequest>);
  if (!response) throw new Error("The browser production worker did not post a response");
  return response;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("document pagination cross-runtime contract", () => {
  it("gives 50,000 unbroken characters the same exact three pages on server and browser", async () => {
    const source = "x".repeat(50_000);
    const serverPages = paginateOnServer(source, "TEXT");
    const browserResponse = await paginateThroughProductionWorker({ source, kind: "TEXT" });

    expect(serverPages, "the backend production path must return exactly three pages").toHaveLength(
      3,
    );
    expect(browserResponse.ok, "the browser production worker must accept the request").toBe(true);
    if (!browserResponse.ok) throw new Error(browserResponse.error);
    expect(
      browserResponse.pages,
      "the browser production worker must return the backend's exact page count",
    ).toHaveLength(serverPages.length);
    expect(
      browserResponse.pages,
      "the backend and browser production paths must return byte-identical pages",
    ).toEqual(serverPages);
  });
});
