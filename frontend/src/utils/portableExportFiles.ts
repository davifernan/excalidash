const isInlineDataUrl = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("data:");

const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
};

const fetchDrawingFileDataUrl = async (
  drawingId: string,
  fileId: string,
  declaredMimeType: unknown,
): Promise<string> => {
  const response = await fetch(
    `/api/files/${encodeURIComponent(drawingId)}/${encodeURIComponent(fileId)}`,
    { credentials: "same-origin" },
  );
  if (!response.ok) {
    throw new Error(`server returned ${response.status}`);
  }
  const responseMimeType = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  const mimeType = responseMimeType.startsWith("image/")
    ? responseMimeType
    : typeof declaredMimeType === "string" && declaredMimeType.startsWith("image/")
      ? declaredMimeType
      : "";
  if (!mimeType) throw new Error("server did not return an image content type");
  const bytes = new Uint8Array(await response.arrayBuffer());
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
};

/**
 * Make a downloaded .excalidraw file self-contained.
 *
 * Persisted scenes deliberately use drawing-scoped /api/files references so
 * the live editor does not carry base64 through every save. A download has the
 * opposite contract: it must remain usable after this instance no longer
 * exists. Fetch every managed image through the authenticated route and fail
 * the whole download if even one cannot be bundled; emitting a knowingly
 * broken file would turn a successful-looking export into data loss.
 */
export const bundleDrawingFilesForExport = async (
  drawingId: string,
  files: Record<string, any> | null | undefined,
): Promise<Record<string, any>> => {
  if (!files || typeof files !== "object") return {};
  const bundled: Record<string, any> = { ...files };
  const pending = Object.entries(files).filter(([, file]) => {
    const dataURL = file?.dataURL;
    return typeof dataURL === "string" && dataURL.length > 0 && !isInlineDataUrl(dataURL);
  });
  const failures: string[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const [fileId, file] = pending[cursor++];
      try {
        const dataURL = await fetchDrawingFileDataUrl(drawingId, fileId, file?.mimeType);
        bundled[fileId] = { ...file, dataURL };
      } catch {
        failures.push(fileId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, () => worker()));
  if (failures.length > 0) {
    throw new Error(
      `Could not bundle ${failures.length} drawing image(s); export cancelled to prevent image loss: ${failures.join(", ")}`,
    );
  }
  return bundled;
};
