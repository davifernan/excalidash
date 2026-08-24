import { useCallback, useEffect, useRef } from "react";
import type { FileCapability } from "../../integrations/excalidraw/capabilities";
import type { FileId } from "../../integrations/excalidraw/types";
import * as api from "../../api";

const FLUSH_INTERVAL_MS = 800;
const UPLOAD_CONCURRENCY = 3;

type UseEditorFileUploadsInput = {
  drawingId?: string;
  fileCapability: FileCapability;
};

/**
 * Background uploader for board images (NIL-381): every image the editor
 * takes in (paste, drop) is pushed to `PUT /files/:drawingId/:fileId`
 * independently of the debounced full-scene save, at most `UPLOAD_CONCURRENCY`
 * at a time, batched every `FLUSH_INTERVAL_MS`.
 *
 * A file counts as uploaded only once the PUT resolves -- "sent" and
 * "arrived" are two different claims, and this hook only ever asserts the
 * second one. `confirmedRef` records exactly that ack, nothing earlier: not
 * when the upload starts, not when it is merely enqueued. A rejected or
 * failed PUT leaves the fileId out of `confirmedRef`, so the same delta
 * computation (`fileCapability.deltaAgainst`) offers it again on the next
 * flush -- retry falls out of the confirmed-set design rather than a
 * separate retry queue. The PUT endpoint is idempotent, so re-sending bytes
 * that actually did arrive costs nothing beyond the wasted request.
 *
 * Deliberately does not change what the debounced full-scene save sends:
 * that save still embeds whatever `dataURL` the file currently has, and the
 * server's own embed interception (fileProcessing.ts) is the fallback for
 * anything this uploader has not gotten to yet. This hook is a faster,
 * additive path to the same storage, not a replacement for the existing one.
 */
export const useEditorFileUploads = ({ drawingId, fileCapability }: UseEditorFileUploadsInput) => {
  const confirmedRef = useRef<Set<FileId>>(new Set());
  const inFlightRef = useRef<Set<FileId>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawingIdRef = useRef(drawingId);
  drawingIdRef.current = drawingId;

  const scheduleFlush = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, FLUSH_INTERVAL_MS);
  }, []);

  // A ref so `flush` can call `scheduleFlush` for a follow-up batch without
  // the effect below re-subscribing on every render `flush`'s own
  // dependencies would otherwise cause.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    const currentDrawingId = drawingIdRef.current;
    if (!currentDrawingId) return;

    const delta = fileCapability.deltaAgainst(confirmedRef.current);
    if (!delta.ok) return;
    const pending = delta.value.filter(
      (file) => file.dataURL.startsWith("data:") && !inFlightRef.current.has(file.id),
    );
    if (pending.length === 0) return;

    for (const file of pending.slice(0, UPLOAD_CONCURRENCY)) {
      inFlightRef.current.add(file.id);
      api
        .uploadDrawingFile(currentDrawingId, file.id, file.dataURL, file.mimeType)
        .then(() => {
          // Only reached on a resolved PUT -- the one place this fileId is
          // ever added to the confirmed set.
          confirmedRef.current.add(file.id);
        })
        .catch((err) => {
          console.warn("[Editor] Background file upload failed, will retry:", file.id, err);
        })
        .finally(() => {
          inFlightRef.current.delete(file.id);
          scheduleFlush();
        });
    }
  };

  useEffect(() => {
    // A different board: nothing confirmed here describes it, and an
    // in-flight upload for the old board's fileId must not be mistaken for
    // one on the new board if the same content hash happens to recur.
    confirmedRef.current = new Set();
    inFlightRef.current = new Set();
  }, [drawingId]);

  useEffect(() => fileCapability.onFilesAdded(scheduleFlush), [fileCapability, scheduleFlush]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    /** Whether this fileId's bytes are confirmed on the server -- an ack, not an attempt. */
    hasUploadedFile: useCallback((fileId: FileId) => confirmedRef.current.has(fileId), []),
  };
};
