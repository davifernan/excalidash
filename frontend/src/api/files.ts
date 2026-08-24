import { api } from "./client";

/**
 * Upload one board image's bytes to PUT /files/:drawingId/:fileId (NIL-381).
 * Idempotent on the server: the same bytes uploaded twice cost nothing extra,
 * which is what makes retrying a failed attempt from the background uploader
 * safe rather than something that needs its own dedup.
 *
 * `dataURL` is the base64 data URL Excalidraw already holds in memory for a
 * pasted/dropped image (`SceneFile.dataURL`); `fetch` decodes it into a Blob
 * without a manual base64 pass. `mimeType` is passed separately rather than
 * re-parsed off the data URL because the caller (SceneFile) already carries
 * it as its own field, and the two must always agree with what the server
 * validates against Content-Type.
 */
export const uploadDrawingFile = async (
  drawingId: string,
  fileId: string,
  dataURL: string,
  mimeType: string,
): Promise<void> => {
  const blob = await (await fetch(dataURL)).blob();
  await api.put(`/files/${encodeURIComponent(drawingId)}/${encodeURIComponent(fileId)}`, blob, {
    headers: { "Content-Type": mimeType },
  });
};
