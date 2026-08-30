import { prepareMarkdownForRender } from "./documentMarkdown";
import type { DocumentMarkdownRequest, DocumentMarkdownResponse } from "./documentMarkdownWorker";

self.onmessage = ({ data }: MessageEvent<DocumentMarkdownRequest>) => {
  let response: DocumentMarkdownResponse;
  try {
    response = { ok: true, tree: prepareMarkdownForRender(data.source) };
  } catch {
    response = { ok: false };
  }
  self.postMessage(response);
};
