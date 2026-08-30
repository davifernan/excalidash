import { prepareMarkdownForRender } from "./documentMarkdown";
import type { DocumentMarkdownRequest, DocumentMarkdownResponse } from "./documentMarkdownWorker";

self.onmessage = ({ data }: MessageEvent<DocumentMarkdownRequest>) => {
  let response: DocumentMarkdownResponse;
  try {
    response = { ok: true, tree: prepareMarkdownForRender(data.source) };
  } catch (error) {
    response = {
      ok: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
    };
  }
  self.postMessage(response);
};
