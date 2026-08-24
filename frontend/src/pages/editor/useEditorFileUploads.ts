import { useCallback, useEffect, useRef } from "react";
import type { FileCapability } from "../../integrations/excalidraw/capabilities";
import type { FileId } from "../../integrations/excalidraw/types";
import * as api from "../../api";
import { log } from "../../logging";

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

  useEffect(() => {
    // A different board: nothing confirmed here describes it, and an
    // in-flight upload for the old board's fileId must not be mistaken for
    // one on the new board if the same content hash happens to recur.
    confirmedRef.current = new Set();
    inFlightRef.current = new Set();
  }, [drawingId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFlush = () => {
      if (!active || timer) return;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, FLUSH_INTERVAL_MS);
    };
    const flush = () => {
      if (!drawingId) return;

      // Capture this board generation's sets. An upload that settles after
      // a board switch must not mutate the replacement board's bookkeeping.
      const confirmed = confirmedRef.current;
      const inFlight = inFlightRef.current;

      // Bounded by TOTAL in-flight uploads, not by how many this one flush
      // call is willing to start: a flush overlapping a previous, still
      // in-flight batch must only fill the capacity that batch left, or the
      // real number running at once silently exceeds UPLOAD_CONCURRENCY.
      const capacity = UPLOAD_CONCURRENCY - inFlight.size;
      if (capacity <= 0) return;

      const delta = fileCapability.deltaAgainst(confirmed);
      if (!delta.ok) return;
      const pending = delta.value.filter(
        (file) => file.dataURL.startsWith("data:") && !inFlight.has(file.id),
      );
      if (pending.length === 0) return;

      for (const file of pending.slice(0, capacity)) {
        inFlight.add(file.id);
        api
          .uploadDrawingFile(drawingId, file.id, file.dataURL, file.mimeType)
          .then(() => {
            // Only reached on a resolved PUT -- the one place this fileId is
            // ever added to the confirmed set.
            confirmed.add(file.id);
          })
          .catch((err) => {
            log.warn("[Editor] Background file upload failed, will retry", {
              fileId: file.id,
              error: err,
            });
          })
          .finally(() => {
            inFlight.delete(file.id);
            scheduleFlush();
          });
      }
    };

    const unsubscribe = fileCapability.onFilesAdded(scheduleFlush);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [drawingId, fileCapability]);

  return {
    /** Whether this fileId's bytes are confirmed on the server -- an ack, not an attempt. */
    hasUploadedFile: useCallback((fileId: FileId) => confirmedRef.current.has(fileId), []),
  };
};
