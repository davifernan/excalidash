import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { notify } from "../../notifications";
import { splitFilesIntoUpdatePayloads, type ElementUpdatePayload } from "./elementUpdateDelivery";
import { boardSettingsSignature, getFilesDelta, shouldSaveBoardSettings } from "./shared";
import type { FileCapability } from "../../integrations/excalidraw/capabilities";

const ELEMENT_ORDER_BYTE_LIMIT = 8 * 1024 * 1024;
const ELEMENT_UPDATE_ACK_TIMEOUT_MS = 3_000;
const ELEMENT_UPDATE_RETRY_DELAY_MS = 1_000;

const elementOrderByteLength = (ids: readonly string[]) => {
  const encoder = new TextEncoder();
  return ids.reduce(
    (total, id, index) => total + encoder.encode(JSON.stringify(id)).byteLength + (index ? 1 : 0),
    2,
  );
};

type UseEditorBroadcastParams = {
  drawingId: string | undefined;
  files: Pick<FileCapability, "read">;
  lastLocalChangeAtRef: MutableRefObject<number>;
  lastSyncedElementOrderSigRef: MutableRefObject<string>;
  lastSyncedFilesRef: MutableRefObject<Record<string, any>>;
  latestAppStateRef: MutableRefObject<any>;
  latestFilesRef: MutableRefObject<any>;
  lastPersistedAppStateSigRef: MutableRefObject<string | null>;
  roomJoinedRef?: MutableRefObject<boolean>;
  socketRef: MutableRefObject<any>;
  debouncedSave: (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files?: Record<string, any>,
  ) => void;
  debouncedSavePreview: (drawingId: string) => void;
  computeElementOrderSig: (elements: readonly any[]) => string;
  hasElementChanged: (element: any) => boolean;
  normalizeImageElementStatus: (
    elements?: readonly any[],
    files?: Record<string, any> | null,
  ) => readonly any[];
  recordElementVersion: (element: any) => void;
  setHasSceneChangesSinceLoad: () => void;
};

type DeliveryPacket = {
  payload: ElementUpdatePayload;
  acknowledge: () => void;
};

type PendingSceneUpdate = {
  elements: readonly any[];
  files: Record<string, any>;
};

type FileContentAttempt = {
  dataURL: unknown;
  metadata: string;
};

type FileDeliveryState = {
  desiredFile: any;
  queued: boolean;
  retrying: boolean;
  retryTimeout: number | null;
};

type RejectedFileNotice = { payloadBytes: number };

type ElementUpdateAck = {
  ok?: boolean;
  error?: { code?: string; message?: string };
  warning?: { code?: string; message?: string };
};

/**
 * What the outbound queue is doing right now, for a test harness that wants
 * to wait for a *state* instead of a number of seconds. Every field is read
 * straight off the refs the delivery loop already keeps; nothing here is
 * computed for the harness's benefit or kept in sync separately.
 *
 * - `inFlight`: either delivery lane currently has a packet on the wire.
 * - `parked`: file or scene work is queued but not on the wire yet.
 * - `retrying`: either lane failed or timed out and is waiting for, or
 *   performing, a retry.
 * - `acknowledgedFileIds`: every file id the server has acked on this
 *   drawing, in ack order. "Sent" and "acked" are different facts; a spec
 *   that only checks the receiving peer cannot tell which of the two failed.
 * - `rejectedFileIds`: files refused locally as too large for live delivery.
 */
export type DeliveryState = {
  inFlight: boolean;
  parked: boolean;
  retrying: boolean;
  acknowledgedFileIds: readonly string[];
  rejectedFileIds: readonly string[];
};

const fileContentAttempt = (file: any): FileContentAttempt => {
  if (!file || typeof file !== "object") {
    return { dataURL: undefined, metadata: JSON.stringify(file) ?? String(file) };
  }
  const { dataURL, ...metadata } = file;
  return { dataURL, metadata: JSON.stringify(metadata) };
};

const isSameFileContent = (previous: FileContentAttempt, file: any): boolean => {
  const next = fileContentAttempt(file);
  return previous.dataURL === next.dataURL && previous.metadata === next.metadata;
};

const referencesRejectedFile = (element: any, rejectedFileIds: ReadonlySet<string>): boolean =>
  element?.type === "image" &&
  !element?.isDeleted &&
  typeof element?.fileId === "string" &&
  rejectedFileIds.has(element.fileId);

const oversizedImageNotice = (
  fileId: string,
  payloadBytes: number,
  elements: readonly any[],
): string | null => {
  const image = elements.find(
    (element) => element?.type === "image" && !element?.isDeleted && element?.fileId === fileId,
  );
  if (!image || !Number.isFinite(image.x) || !Number.isFinite(image.y)) return null;
  const x = Math.round(image.x);
  const y = Math.round(image.y);
  const megabytes = (payloadBytes / (1024 * 1024)).toFixed(1);
  return `Image near canvas position (${x}, ${y}) is too large for live collaboration (${megabytes} MB).`;
};

const oversizedImageFallbackNotice = (payloadBytes: number): string => {
  const megabytes = (payloadBytes / (1024 * 1024)).toFixed(1);
  return `An image from the previous board is too large for live collaboration (${megabytes} MB).`;
};

export const useEditorBroadcast = ({
  drawingId,
  files,
  lastLocalChangeAtRef,
  lastSyncedElementOrderSigRef,
  lastSyncedFilesRef,
  latestAppStateRef,
  latestFilesRef,
  lastPersistedAppStateSigRef,
  roomJoinedRef,
  socketRef,
  debouncedSave,
  debouncedSavePreview,
  computeElementOrderSig,
  hasElementChanged,
  normalizeImageElementStatus,
  recordElementVersion,
  setHasSceneChangesSinceLoad,
}: UseEditorBroadcastParams) => {
  const throttleTimeoutRef = useRef<number | null>(null);
  const sceneRetryTimeoutRef = useRef<number | null>(null);
  const fileWakeTimeoutRef = useRef<number | null>(null);
  const deliveryGenerationRef = useRef(0);
  // File packets use a fair, per-file retry queue so one slow upload cannot
  // monopolize collaboration. Scene packets stay on a separate serialized
  // lane because element versions and elementOrder must never overtake.
  const sceneSendingRef = useRef(false);
  const pendingSceneUpdateRef = useRef<PendingSceneUpdate | null>(null);
  const fileDeliveryQueueRef = useRef<string[]>([]);
  const fileDeliveryStatesRef = useRef(new Map<string, FileDeliveryState>());
  const activeFileDeliveryRef = useRef<ReadonlySet<string> | null>(null);
  const rejectedFileAttemptsRef = useRef(new Map<string, FileContentAttempt>());
  const rejectedFileNoticesRef = useRef(new Map<string, RejectedFileNotice>());
  const rejectedFilesDrawingIdRef = useRef<string | undefined>(drawingId);
  const drainFileDeliveriesRef = useRef<() => void>(() => undefined);
  const drainSceneDeliveryRef = useRef<() => void>(() => undefined);
  const acknowledgedFileIdsRef = useRef<string[]>([]);
  const lastRunAtRef = useRef(0);
  const trailingArgsRef = useRef<[readonly any[], Record<string, any> | undefined] | null>(null);
  const canDeliverToRoom = useCallback(() => {
    const socket = socketRef.current;
    return Boolean(socket && socket.connected !== false && roomJoinedRef?.current !== false);
  }, [roomJoinedRef, socketRef]);
  const deliverPackets = useCallback(
    (packets: readonly DeliveryPacket[], onFinished: (delivered: boolean) => void) => {
      const generation = deliveryGenerationRef.current;
      let packetIndex = 0;
      let finished = false;

      const finish = (delivered: boolean) => {
        if (finished || deliveryGenerationRef.current !== generation) return;
        finished = true;
        onFinished(delivered);
      };

      const sendCurrent = () => {
        if (deliveryGenerationRef.current !== generation) return;
        const packet = packets[packetIndex];
        if (!packet) {
          finish(true);
          return;
        }
        const socket = socketRef.current;
        if (!canDeliverToRoom()) {
          sceneRetryTimeoutRef.current = window.setTimeout(() => {
            sceneRetryTimeoutRef.current = null;
            sendCurrent();
          }, ELEMENT_UPDATE_RETRY_DELAY_MS);
          return;
        }

        let attemptSettled = false;
        const acknowledge = (transportError: unknown, response?: ElementUpdateAck) => {
          if (attemptSettled || deliveryGenerationRef.current !== generation) return;
          attemptSettled = true;
          if (transportError || response?.error?.code === "rate-limited") {
            const message = response?.error?.message;
            if (typeof message === "string") notify("error", message);
            sceneRetryTimeoutRef.current = window.setTimeout(() => {
              sceneRetryTimeoutRef.current = null;
              sendCurrent();
            }, ELEMENT_UPDATE_RETRY_DELAY_MS);
            return;
          }
          if (!response?.ok) {
            const message = response?.error?.message;
            if (typeof message === "string") notify("error", message);
            finish(false);
            return;
          }

          packet.acknowledge();
          const warning = response.warning?.message;
          if (typeof warning === "string") notify("error", warning);
          packetIndex += 1;
          sendCurrent();
        };

        if (typeof socket.timeout === "function") {
          socket
            .timeout(ELEMENT_UPDATE_ACK_TIMEOUT_MS)
            .emit("element-update", packet.payload, acknowledge);
        } else {
          socket.emit("element-update", packet.payload, (response: ElementUpdateAck) =>
            acknowledge(null, response),
          );
        }
      };

      sendCurrent();
    },
    [canDeliverToRoom, socketRef],
  );

  const drainFileDeliveries = useCallback(() => {
    if (activeFileDeliveryRef.current !== null) return;
    const generation = deliveryGenerationRef.current;

    const scheduleWake = () => {
      if (fileWakeTimeoutRef.current !== null) return;
      fileWakeTimeoutRef.current = window.setTimeout(() => {
        fileWakeTimeoutRef.current = null;
        drainFileDeliveriesRef.current();
      }, 100);
    };

    const scheduleRetry = (fileId: string, state: FileDeliveryState) => {
      if (state.retryTimeout !== null) return;
      state.retrying = true;
      state.retryTimeout = window.setTimeout(() => {
        state.retryTimeout = null;
        if (deliveryGenerationRef.current !== generation || state.queued) return;
        state.queued = true;
        fileDeliveryQueueRef.current.push(fileId);
        drainFileDeliveriesRef.current();
      }, ELEMENT_UPDATE_RETRY_DELAY_MS);
    };

    if (fileDeliveryQueueRef.current.length === 0) return;
    if (!drawingId || !canDeliverToRoom()) {
      scheduleWake();
      return;
    }

    const queuedFiles: Record<string, any> = {};
    const eligibleQueue: string[] = [];
    for (const fileId of fileDeliveryQueueRef.current) {
      const state = fileDeliveryStatesRef.current.get(fileId);
      if (!state?.queued || state.retryTimeout !== null || fileId in queuedFiles) continue;
      eligibleQueue.push(fileId);
    }
    if (eligibleQueue.length === 0) return;
    // A retry may already be queued when a fresh file arrives during a
    // disconnect. Fresh work goes first, and a batch never mixes it with an
    // older retry whose large frame could recreate head-of-line blocking.
    eligibleQueue.sort((left, right) => {
      const leftRetrying = fileDeliveryStatesRef.current.get(left)?.retrying ?? false;
      const rightRetrying = fileDeliveryStatesRef.current.get(right)?.retrying ?? false;
      return Number(leftRetrying) - Number(rightRetrying);
    });
    fileDeliveryQueueRef.current = eligibleQueue;
    const batchIsRetry = fileDeliveryStatesRef.current.get(eligibleQueue[0])?.retrying ?? false;
    for (const fileId of eligibleQueue) {
      const state = fileDeliveryStatesRef.current.get(fileId)!;
      if (state.retrying !== batchIsRetry) break;
      queuedFiles[fileId] = state.desiredFile;
    }

    const split = splitFilesIntoUpdatePayloads({ drawingId, files: queuedFiles });
    if (!split.ok) {
      const state = fileDeliveryStatesRef.current.get(split.fileId);
      if (state) {
        state.queued = false;
        fileDeliveryStatesRef.current.delete(split.fileId);
      }
      fileDeliveryQueueRef.current = fileDeliveryQueueRef.current.filter(
        (fileId) => fileId !== split.fileId,
      );
      drainFileDeliveriesRef.current();
      return;
    }
    const payload = split.payloads[0];
    const attemptFiles = payload?.files ?? {};
    const attemptFileIds = new Set(Object.keys(attemptFiles));
    if (attemptFileIds.size === 0) return;
    const attemptContents = new Map(
      Object.entries(attemptFiles).map(([fileId, file]) => [fileId, fileContentAttempt(file)]),
    );
    fileDeliveryQueueRef.current = fileDeliveryQueueRef.current.filter(
      (fileId) => !attemptFileIds.has(fileId),
    );
    for (const fileId of attemptFileIds) {
      const state = fileDeliveryStatesRef.current.get(fileId);
      if (state) state.queued = false;
    }

    const socket = socketRef.current;
    activeFileDeliveryRef.current = attemptFileIds;
    let attemptSettled = false;
    const queueCurrentVersion = (fileId: string, state: FileDeliveryState) => {
      if (state.retryTimeout !== null) {
        window.clearTimeout(state.retryTimeout);
        state.retryTimeout = null;
      }
      state.retrying = false;
      if (!state.queued) {
        state.queued = true;
        fileDeliveryQueueRef.current.push(fileId);
      }
    };
    const acknowledge = (transportError: unknown, response?: ElementUpdateAck) => {
      if (
        attemptSettled ||
        deliveryGenerationRef.current !== generation ||
        activeFileDeliveryRef.current !== attemptFileIds
      ) {
        return;
      }
      attemptSettled = true;
      activeFileDeliveryRef.current = null;

      if (transportError || response?.error?.code === "rate-limited") {
        const message = response?.error?.message;
        if (typeof message === "string") notify("error", message);
        for (const fileId of attemptFileIds) {
          const state = fileDeliveryStatesRef.current.get(fileId);
          if (!state) continue;
          const attempted = attemptContents.get(fileId)!;
          const desired = fileContentAttempt(state.desiredFile);
          // Excalidraw may refresh metadata such as lastRetrieved while the
          // bytes are in flight. That is still the same blocked upload, so it
          // remains a retry instead of joining a fresh-file batch.
          if (attempted.dataURL === desired.dataURL) scheduleRetry(fileId, state);
          else queueCurrentVersion(fileId, state);
        }
        // Failed files yield the slot. Files which arrived while this batch
        // was in flight can pass before an unchanged retry becomes eligible.
        drainFileDeliveriesRef.current();
        return;
      }
      if (!response?.ok) {
        const message = response?.error?.message;
        if (typeof message === "string") notify("error", message);
        for (const fileId of attemptFileIds) {
          const state = fileDeliveryStatesRef.current.get(fileId);
          if (!state) continue;
          const attempted = attemptContents.get(fileId)!;
          if (isSameFileContent(attempted, state.desiredFile)) {
            fileDeliveryStatesRef.current.delete(fileId);
          } else {
            // A hard rejection describes the attempted bytes, not a newer
            // replacement selected while that acknowledgement was pending.
            queueCurrentVersion(fileId, state);
          }
        }
        drainFileDeliveriesRef.current();
        return;
      }

      lastSyncedFilesRef.current = {
        ...lastSyncedFilesRef.current,
        ...attemptFiles,
      };
      acknowledgedFileIdsRef.current = [...acknowledgedFileIdsRef.current, ...attemptFileIds];
      const warning = response.warning?.message;
      if (typeof warning === "string") notify("error", warning);
      for (const fileId of attemptFileIds) {
        const state = fileDeliveryStatesRef.current.get(fileId);
        if (!state) continue;
        const attempted = attemptContents.get(fileId)!;
        if (isSameFileContent(attempted, state.desiredFile)) {
          fileDeliveryStatesRef.current.delete(fileId);
        } else {
          queueCurrentVersion(fileId, state);
        }
      }
      drainSceneDeliveryRef.current();
      drainFileDeliveriesRef.current();
    };

    // A large frame can keep the sender's main thread busy long enough for a
    // fixed acknowledgement timer to fire even though the server already
    // accepted and answered the packet. Retrying the same bytes then creates
    // the load that keeps hiding the ack. The server answers every admitted
    // element-update; only a real transport disconnect makes that answer
    // unreachable and justifies requeueing the file.
    const onDisconnect = () => acknowledge(new Error("socket disconnected"));
    socket.once?.("disconnect", onDisconnect);
    socket.emit("element-update", payload, (response: ElementUpdateAck) => {
      socket.off?.("disconnect", onDisconnect);
      acknowledge(null, response);
    });
    if (socket.connected === false) onDisconnect();
  }, [canDeliverToRoom, drawingId, lastSyncedFilesRef, socketRef]);

  const queueFileDelivery = useCallback((fileId: string, file: any) => {
    const existing = fileDeliveryStatesRef.current.get(fileId);
    if (existing) {
      const previous = fileContentAttempt(existing.desiredFile);
      if (isSameFileContent(previous, file)) return;
      const next = fileContentAttempt(file);
      existing.desiredFile = file;
      if (existing.retrying && previous.dataURL === next.dataURL) return;
      if (existing.retryTimeout !== null) {
        window.clearTimeout(existing.retryTimeout);
        existing.retryTimeout = null;
      }
      if (!activeFileDeliveryRef.current?.has(fileId) && !existing.queued) {
        existing.queued = true;
        fileDeliveryQueueRef.current.push(fileId);
      }
    } else {
      fileDeliveryStatesRef.current.set(fileId, {
        desiredFile: file,
        queued: true,
        retrying: false,
        retryTimeout: null,
      });
      fileDeliveryQueueRef.current.push(fileId);
    }
  }, []);

  const drainSceneDelivery = useCallback(() => {
    if (sceneSendingRef.current) return;
    const pending = pendingSceneUpdateRef.current;
    if (!pending || !drawingId) return;

    const normalizedElements = normalizeImageElementStatus(pending.elements, pending.files);
    const candidateChanges = normalizedElements.filter((element) => hasElementChanged(element));
    const nextOrderSig = computeElementOrderSig(normalizedElements);
    const shouldSyncOrder = nextOrderSig !== lastSyncedElementOrderSigRef.current;
    const unconfirmedFileIds = new Set(
      Object.keys(getFilesDelta(lastSyncedFilesRef.current, pending.files)),
    );
    const rejectedFileIds = new Set<string>();
    for (const [fileId, attempt] of rejectedFileAttemptsRef.current) {
      if (fileId in pending.files && isSameFileContent(attempt, pending.files[fileId])) {
        rejectedFileIds.add(fileId);
      }
    }
    const blockedFileIds = new Set([...unconfirmedFileIds, ...rejectedFileIds]);
    const changes = candidateChanges.filter(
      (element) => !referencesRejectedFile(element, blockedFileIds),
    );
    const hasBlockedImage = normalizedElements.some((element) =>
      referencesRejectedFile(element, blockedFileIds),
    );
    const shouldDeliverOrder = shouldSyncOrder && !hasBlockedImage;

    if (changes.length === 0 && !shouldDeliverOrder) {
      if (!hasBlockedImage) pendingSceneUpdateRef.current = null;
      return;
    }

    const elementOrder = shouldDeliverOrder
      ? normalizedElements
          .filter((element: any) => !element?.isDeleted)
          .map((element: any) => element?.id)
          .filter((id): id is string => Boolean(id))
      : undefined;
    const orderBytes = elementOrder ? elementOrderByteLength(elementOrder) : 0;
    const packet: DeliveryPacket = {
      payload: {
        drawingId,
        elements: changes,
        elementOrder:
          elementOrder && orderBytes <= ELEMENT_ORDER_BYTE_LIMIT ? elementOrder : undefined,
        elementOrderOmittedBytes:
          elementOrder && orderBytes > ELEMENT_ORDER_BYTE_LIMIT ? orderBytes : undefined,
      },
      acknowledge: () => {
        changes.forEach((element) => recordElementVersion(element));
        if (shouldDeliverOrder) {
          lastSyncedElementOrderSigRef.current = nextOrderSig;
        }
      },
    };

    pendingSceneUpdateRef.current = null;
    sceneSendingRef.current = true;
    deliverPackets([packet], (delivered) => {
      sceneSendingRef.current = false;
      if (delivered && hasBlockedImage && pendingSceneUpdateRef.current === null) {
        pendingSceneUpdateRef.current = pending;
      } else if (!delivered) {
        pendingSceneUpdateRef.current = null;
      }
      drainSceneDeliveryRef.current();
    });
  }, [
    computeElementOrderSig,
    deliverPackets,
    drawingId,
    hasElementChanged,
    lastSyncedElementOrderSigRef,
    lastSyncedFilesRef,
    normalizeImageElementStatus,
    recordElementVersion,
  ]);

  useEffect(() => {
    drainFileDeliveriesRef.current = drainFileDeliveries;
    drainSceneDeliveryRef.current = drainSceneDelivery;
  }, [drainFileDeliveries, drainSceneDelivery]);

  const deliverPendingRejectionNoticesAndResetDrawing = useCallback(
    (nextDrawingId: string | undefined) => {
      if (rejectedFilesDrawingIdRef.current === nextDrawingId) return;
      for (const notice of rejectedFileNoticesRef.current.values()) {
        notify("error", oversizedImageFallbackNotice(notice.payloadBytes));
      }
      rejectedFileAttemptsRef.current.clear();
      rejectedFileNoticesRef.current.clear();
      acknowledgedFileIdsRef.current = [];
      rejectedFilesDrawingIdRef.current = nextDrawingId;
    },
    [],
  );

  useEffect(() => {
    deliverPendingRejectionNoticesAndResetDrawing(drawingId);
  }, [deliverPendingRejectionNoticesAndResetDrawing, drawingId]);

  const queueUpdate = useCallback(
    (elements: readonly any[], currentFiles?: Record<string, any>, filesOnly = false): boolean => {
      if (!socketRef.current || !drawingId) return false;
      let nextFiles = currentFiles;
      if (!nextFiles) {
        const fileState = files.read();
        if (!fileState.ok) {
          notify("error", "Live collaboration could not read editor files.");
          return false;
        }
        nextFiles = fileState.value;
      }
      const rawFilesDelta = getFilesDelta(lastSyncedFilesRef.current, nextFiles);
      if (Object.keys(nextFiles).length > 0) latestFilesRef.current = nextFiles;

      const normalizedElements = filesOnly
        ? elements
        : normalizeImageElementStatus(elements, nextFiles);
      const candidateChanges = filesOnly
        ? []
        : normalizedElements.filter((element) => hasElementChanged(element));
      const nextOrderSig = filesOnly ? undefined : computeElementOrderSig(normalizedElements);
      const shouldSyncOrder =
        nextOrderSig !== undefined && nextOrderSig !== lastSyncedElementOrderSigRef.current;
      const settingsChanged =
        !filesOnly &&
        shouldSaveBoardSettings(lastPersistedAppStateSigRef.current, latestAppStateRef.current);

      deliverPendingRejectionNoticesAndResetDrawing(drawingId);
      for (const fileId of rejectedFileAttemptsRef.current.keys()) {
        if (!(fileId in nextFiles) || !(fileId in rawFilesDelta)) {
          rejectedFileAttemptsRef.current.delete(fileId);
          rejectedFileNoticesRef.current.delete(fileId);
        }
      }
      const rejectedFileIds = new Set<string>();
      const deliverableFiles = Object.fromEntries(
        Object.entries(rawFilesDelta).filter(([fileId, file]) => {
          const previousAttempt = rejectedFileAttemptsRef.current.get(fileId);
          if (!previousAttempt) return true;
          if (isSameFileContent(previousAttempt, file)) {
            rejectedFileIds.add(fileId);
            return false;
          }
          rejectedFileAttemptsRef.current.delete(fileId);
          rejectedFileNoticesRef.current.delete(fileId);
          return true;
        }),
      );

      let filePreflight = splitFilesIntoUpdatePayloads({ drawingId, files: deliverableFiles });
      while (!filePreflight.ok) {
        const rejectedFile = deliverableFiles[filePreflight.fileId];
        // This is a local refusal marker, not a delivery marker. Keeping the
        // exact rejected content separate from lastSyncedFilesRef prevents it
        // from blocking every later update without ever claiming server ACK.
        rejectedFileAttemptsRef.current.set(filePreflight.fileId, fileContentAttempt(rejectedFile));
        rejectedFileNoticesRef.current.set(filePreflight.fileId, {
          payloadBytes: filePreflight.payloadBytes,
        });
        rejectedFileIds.add(filePreflight.fileId);
        delete deliverableFiles[filePreflight.fileId];
        filePreflight = splitFilesIntoUpdatePayloads({ drawingId, files: deliverableFiles });
      }

      // Excalidraw stores image bytes before it publishes the corresponding
      // element. Hold the notice until that element arrives, so the message can
      // identify what the user placed instead of exposing its content hash.
      for (const [fileId, notice] of rejectedFileNoticesRef.current) {
        const message = oversizedImageNotice(fileId, notice.payloadBytes, normalizedElements);
        if (!message) continue;
        notify("error", message);
        rejectedFileNoticesRef.current.delete(fileId);
      }

      const changes = candidateChanges.filter(
        (element) => !referencesRejectedFile(element, rejectedFileIds),
      );
      const shouldDeliverOrder =
        shouldSyncOrder &&
        !normalizedElements.some((element) => referencesRejectedFile(element, rejectedFileIds));

      for (const [fileId, file] of Object.entries(deliverableFiles)) {
        queueFileDelivery(fileId, file);
      }
      drainFileDeliveriesRef.current();

      if (!filesOnly) {
        pendingSceneUpdateRef.current = { elements, files: nextFiles };
        drainSceneDeliveryRef.current();
      }

      const hasDeliveryWork =
        Object.keys(deliverableFiles).length > 0 || changes.length > 0 || shouldDeliverOrder;
      if (hasDeliveryWork) {
        setHasSceneChangesSinceLoad();
        lastLocalChangeAtRef.current = Date.now();
      }

      if (!filesOnly && (hasDeliveryWork || settingsChanged)) {
        const appState = latestAppStateRef.current;
        if (appState) {
          if (settingsChanged) {
            lastPersistedAppStateSigRef.current = boardSettingsSignature(appState);
          }
          debouncedSave(drawingId, normalizedElements, appState, nextFiles);
          debouncedSavePreview(drawingId);
        }
      }

      return hasDeliveryWork;
    },
    [
      computeElementOrderSig,
      files,
      debouncedSave,
      debouncedSavePreview,
      deliverPendingRejectionNoticesAndResetDrawing,
      drawingId,
      hasElementChanged,
      lastLocalChangeAtRef,
      lastPersistedAppStateSigRef,
      lastSyncedElementOrderSigRef,
      lastSyncedFilesRef,
      latestAppStateRef,
      latestFilesRef,
      normalizeImageElementStatus,
      queueFileDelivery,
      setHasSceneChangesSinceLoad,
      socketRef,
    ],
  );

  const broadcastChanges = useCallback(
    (elements: readonly any[], currentFiles?: Record<string, any>) => {
      const now = Date.now();
      const elapsed = now - lastRunAtRef.current;
      if (elapsed >= 100) {
        if (throttleTimeoutRef.current) {
          window.clearTimeout(throttleTimeoutRef.current);
          throttleTimeoutRef.current = null;
          trailingArgsRef.current = null;
        }
        lastRunAtRef.current = now;
        queueUpdate(elements, currentFiles);
        return;
      }

      trailingArgsRef.current = [elements, currentFiles];
      if (throttleTimeoutRef.current) return;
      throttleTimeoutRef.current = window.setTimeout(() => {
        throttleTimeoutRef.current = null;
        const args = trailingArgsRef.current;
        trailingArgsRef.current = null;
        if (!args) return;
        lastRunAtRef.current = Date.now();
        queueUpdate(...args);
      }, 100 - elapsed);
    },
    [queueUpdate],
  );

  const broadcastFiles = useCallback(
    (files: Record<string, any>) => queueUpdate([], files, true),
    [queueUpdate],
  );

  useEffect(
    () => () => {
      deliveryGenerationRef.current += 1;
      sceneSendingRef.current = false;
      pendingSceneUpdateRef.current = null;
      activeFileDeliveryRef.current = null;
      fileDeliveryQueueRef.current = [];
      if (throttleTimeoutRef.current !== null) {
        window.clearTimeout(throttleTimeoutRef.current);
      }
      if (sceneRetryTimeoutRef.current !== null) {
        window.clearTimeout(sceneRetryTimeoutRef.current);
      }
      if (fileWakeTimeoutRef.current !== null) {
        window.clearTimeout(fileWakeTimeoutRef.current);
      }
      for (const state of fileDeliveryStatesRef.current.values()) {
        if (state.retryTimeout !== null) window.clearTimeout(state.retryTimeout);
      }
      fileDeliveryStatesRef.current.clear();
    },
    [],
  );

  const getDeliveryState = useCallback((): DeliveryState => {
    const fileStates = [...fileDeliveryStatesRef.current.values()];
    return {
      inFlight: activeFileDeliveryRef.current !== null || sceneSendingRef.current,
      parked: fileDeliveryQueueRef.current.length > 0 || pendingSceneUpdateRef.current !== null,
      retrying:
        sceneRetryTimeoutRef.current !== null ||
        fileStates.some((state) => state.retrying || state.retryTimeout !== null),
      acknowledgedFileIds: acknowledgedFileIdsRef.current,
      rejectedFileIds: [...rejectedFileAttemptsRef.current.keys()],
    };
  }, []);

  return { broadcastChanges, broadcastFiles, getDeliveryState };
};
