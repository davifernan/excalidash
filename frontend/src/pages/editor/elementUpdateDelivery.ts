import type { ElementUpdatePayload } from "@excalidash/domain/collaboration";

export const LIVE_UPDATE_MAX_BYTES = 11 * 1024 * 1024;
export const LIVE_UPDATE_MAX_FILES = 1_000;
export const LIVE_UPDATE_MAX_FILE_DATA_URL_LENGTH = 10 * 1024 * 1024;

export type { ElementUpdatePayload } from "@excalidash/domain/collaboration";

export type FilePayloadSplit =
  | { ok: true; payloads: ElementUpdatePayload[] }
  | { ok: false; fileId: string; payloadBytes: number };

export const elementUpdatePayloadBytes = (payload: ElementUpdatePayload): number =>
  new TextEncoder().encode(JSON.stringify(payload)).byteLength;

/**
 * Builds file-only packets below the client delivery ceiling. The whole set is
 * preflighted before a packet is returned, so one indivisible oversized file
 * cannot produce a partial delivery followed by an element that references a
 * file its peers never received.
 */
export const splitFilesIntoUpdatePayloads = ({
  drawingId,
  files,
  maxBytes = LIVE_UPDATE_MAX_BYTES,
  maxFiles = LIVE_UPDATE_MAX_FILES,
}: {
  drawingId: string;
  files: Record<string, any>;
  maxBytes?: number;
  maxFiles?: number;
}): FilePayloadSplit => {
  const entries = Object.entries(files);
  for (const [fileId, file] of entries) {
    const payloadBytes = elementUpdatePayloadBytes({
      drawingId,
      elements: [],
      files: { [fileId]: file },
    });
    if (
      maxFiles < 1 ||
      payloadBytes > maxBytes ||
      (typeof file?.dataURL === "string" &&
        file.dataURL.length > LIVE_UPDATE_MAX_FILE_DATA_URL_LENGTH)
    ) {
      return { ok: false, fileId, payloadBytes };
    }
  }

  const payloads: ElementUpdatePayload[] = [];
  let batch: Record<string, any> = {};
  for (const [fileId, file] of entries) {
    const candidate = { ...batch, [fileId]: file };
    const candidatePayload = { drawingId, elements: [], files: candidate };
    if (
      Object.keys(batch).length > 0 &&
      (Object.keys(candidate).length > maxFiles ||
        elementUpdatePayloadBytes(candidatePayload) > maxBytes)
    ) {
      payloads.push({ drawingId, elements: [], files: batch });
      batch = { [fileId]: file };
    } else {
      batch = candidate;
    }
  }
  if (Object.keys(batch).length > 0) {
    payloads.push({ drawingId, elements: [], files: batch });
  }
  return { ok: true, payloads };
};
