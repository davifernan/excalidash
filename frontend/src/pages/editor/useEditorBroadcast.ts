import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
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
  retryTimeout: number | null;
};

type ElementUpdateAck = {
  ok?: boolean;
  error?: { code?: string; message?: string };
  warning?: { code?: string; message?: string };
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

export const useEditorBroadcast = ({
  drawingId,
  files,
  lastLocalChangeAtRef,
  lastSyncedElementOrderSigRef,
  lastSyncedFilesRef,
  latestAppStateRef,
  latestFilesRef,
  lastPersistedAppStateSigRef,
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
  const deliveryGenerationRef = useRef(0);
  // File packets use a fair, per-file retry queue so one slow upload cannot
  // monopolize collaboration. Scene packets stay on a separate serialized
  // lane because element versions and elementOrder must never overtake.
  const sceneSendingRef = useRef(false);
  const pendingSceneUpdateRef = useRef<PendingSceneUpdate | null>(null);
  const fileDeliveryQueueRef = useRef<string[]>([]);
  const fileDeliveryStatesRef = useRef(new Map<string, FileDeliveryState>());
  const activeFileDeliveryRef = useRef<string | null>(null);
  const rejectedFileAttemptsRef = useRef(new Map<string, FileContentAttempt>());
  const rejectedFilesDrawingIdRef = useRef<string | undefined>(drawingId);
  const drainFileDeliveriesRef = useRef<() => void>(() => undefined);
  const drainSceneDeliveryRef = useRef<() => void>(() => undefined);
  const lastRunAtRef = useRef(0);
  const trailingArgsRef = useRef<[readonly any[], Record<string, any> | undefined] | null>(null);
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
        if (!socket) {
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
            if (typeof message === "string") toast.error(message);
            sceneRetryTimeoutRef.current = window.setTimeout(() => {
              sceneRetryTimeoutRef.current = null;
              sendCurrent();
            }, ELEMENT_UPDATE_RETRY_DELAY_MS);
            return;
          }
          if (!response?.ok) {
            const message = response?.error?.message;
            if (typeof message === "string") toast.error(message);
            finish(false);
            return;
          }

          packet.acknowledge();
          const warning = response.warning?.message;
          if (typeof warning === "string") toast.error(warning);
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
    [socketRef],
  );

  const drainFileDeliveries = useCallback(() => {
    if (activeFileDeliveryRef.current !== null) return;
    const generation = deliveryGenerationRef.current;

    const scheduleRetry = (fileId: string, state: FileDeliveryState) => {
      if (state.retryTimeout !== null) return;
      state.retryTimeout = window.setTimeout(() => {
        state.retryTimeout = null;
        if (deliveryGenerationRef.current !== generation || state.queued) return;
        state.queued = true;
        fileDeliveryQueueRef.current.push(fileId);
        drainFileDeliveriesRef.current();
      }, ELEMENT_UPDATE_RETRY_DELAY_MS);
    };

    while (fileDeliveryQueueRef.current.length > 0) {
      const fileId = fileDeliveryQueueRef.current.shift();
      if (!fileId) continue;
      const state = fileDeliveryStatesRef.current.get(fileId);
      if (!state) continue;
      state.queued = false;
      if (state.retryTimeout !== null) continue;

      const socket = socketRef.current;
      if (!socket) {
        scheduleRetry(fileId, state);
        continue;
      }

      const attemptFile = state.desiredFile;
      const attemptContent = fileContentAttempt(attemptFile);
      const payload: ElementUpdatePayload = {
        drawingId: drawingId!,
        elements: [],
        files: { [fileId]: attemptFile },
      };
      activeFileDeliveryRef.current = fileId;
      let attemptSettled = false;
      const acknowledge = (transportError: unknown, response?: ElementUpdateAck) => {
        if (
          attemptSettled ||
          deliveryGenerationRef.current !== generation ||
          activeFileDeliveryRef.current !== fileId
        ) {
          return;
        }
        attemptSettled = true;
        activeFileDeliveryRef.current = null;
        const currentState = fileDeliveryStatesRef.current.get(fileId);
        if (!currentState) {
          drainFileDeliveriesRef.current();
          return;
        }

        if (transportError || response?.error?.code === "rate-limited") {
          const message = response?.error?.message;
          if (typeof message === "string") toast.error(message);
          scheduleRetry(fileId, currentState);
          // A failed file attempt yields the single file slot. A different
          // file can now pass before this one becomes retryable again.
          drainFileDeliveriesRef.current();
          return;
        }
        if (!response?.ok) {
          const message = response?.error?.message;
          if (typeof message === "string") toast.error(message);
          fileDeliveryStatesRef.current.delete(fileId);
          drainFileDeliveriesRef.current();
          return;
        }

        lastSyncedFilesRef.current = {
          ...lastSyncedFilesRef.current,
          [fileId]: attemptFile,
        };
        const warning = response.warning?.message;
        if (typeof warning === "string") toast.error(warning);
        if (isSameFileContent(attemptContent, currentState.desiredFile)) {
          fileDeliveryStatesRef.current.delete(fileId);
        } else if (!currentState.queued) {
          currentState.queued = true;
          fileDeliveryQueueRef.current.push(fileId);
        }
        drainSceneDeliveryRef.current();
        drainFileDeliveriesRef.current();
      };

      if (typeof socket.timeout === "function") {
        socket.timeout(ELEMENT_UPDATE_ACK_TIMEOUT_MS).emit("element-update", payload, acknowledge);
      } else {
        socket.emit("element-update", payload, (response: ElementUpdateAck) =>
          acknowledge(null, response),
        );
      }
      return;
    }
  }, [drawingId, lastSyncedFilesRef, socketRef]);

  const queueFileDelivery = useCallback((fileId: string, file: any) => {
    const existing = fileDeliveryStatesRef.current.get(fileId);
    if (existing) {
      if (isSameFileContent(fileContentAttempt(existing.desiredFile), file)) return;
      existing.desiredFile = file;
      if (
        activeFileDeliveryRef.current !== fileId &&
        existing.retryTimeout === null &&
        !existing.queued
      ) {
        existing.queued = true;
        fileDeliveryQueueRef.current.push(fileId);
      }
    } else {
      fileDeliveryStatesRef.current.set(fileId, {
        desiredFile: file,
        queued: true,
        retryTimeout: null,
      });
      fileDeliveryQueueRef.current.push(fileId);
    }
    drainFileDeliveriesRef.current();
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

  const queueUpdate = useCallback(
    (elements: readonly any[], currentFiles?: Record<string, any>, filesOnly = false): boolean => {
      if (!socketRef.current || !drawingId) return false;
      let nextFiles = currentFiles;
      if (!nextFiles) {
        const fileState = files.read();
        if (!fileState.ok) {
          toast.error("Live collaboration could not read editor files.");
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

      if (rejectedFilesDrawingIdRef.current !== drawingId) {
        rejectedFileAttemptsRef.current.clear();
        rejectedFilesDrawingIdRef.current = drawingId;
      }
      for (const fileId of rejectedFileAttemptsRef.current.keys()) {
        if (!(fileId in nextFiles) || !(fileId in rawFilesDelta)) {
          rejectedFileAttemptsRef.current.delete(fileId);
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
        rejectedFileIds.add(filePreflight.fileId);
        toast.error(
          `File ${filePreflight.fileId} is too large for live collaboration (${filePreflight.payloadBytes} bytes)`,
        );
        delete deliverableFiles[filePreflight.fileId];
        filePreflight = splitFilesIntoUpdatePayloads({ drawingId, files: deliverableFiles });
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
      for (const state of fileDeliveryStatesRef.current.values()) {
        if (state.retryTimeout !== null) window.clearTimeout(state.retryTimeout);
      }
      fileDeliveryStatesRef.current.clear();
    },
    [],
  );

  return { broadcastChanges, broadcastFiles };
};
