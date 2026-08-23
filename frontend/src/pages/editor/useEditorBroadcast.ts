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

type PendingUpdate = {
  elements: readonly any[];
  files?: Record<string, any>;
  filesOnly: boolean;
};

type RejectedFileAttempt = {
  dataURL: unknown;
  metadata: string;
};

type ElementUpdateAck = {
  ok?: boolean;
  error?: { code?: string; message?: string };
  warning?: { code?: string; message?: string };
};

const rejectedFileAttempt = (file: any): RejectedFileAttempt => {
  if (!file || typeof file !== "object") {
    return { dataURL: undefined, metadata: JSON.stringify(file) ?? String(file) };
  }
  const { dataURL, ...metadata } = file;
  return { dataURL, metadata: JSON.stringify(metadata) };
};

const isSameRejectedFileAttempt = (previous: RejectedFileAttempt, file: any): boolean => {
  const next = rejectedFileAttempt(file);
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
  const retryTimeoutRef = useRef<number | null>(null);
  const deliveryGenerationRef = useRef(0);
  const sendingRef = useRef(false);
  const pendingUpdateRef = useRef<PendingUpdate | null>(null);
  const rejectedFileAttemptsRef = useRef(new Map<string, RejectedFileAttempt>());
  const rejectedFilesDrawingIdRef = useRef<string | undefined>(drawingId);
  const queueUpdateRef = useRef<
    (elements: readonly any[], files?: Record<string, any>, filesOnly?: boolean) => boolean
  >(() => false);
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
          retryTimeoutRef.current = window.setTimeout(() => {
            retryTimeoutRef.current = null;
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
            retryTimeoutRef.current = window.setTimeout(() => {
              retryTimeoutRef.current = null;
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
      const shouldSyncFiles = Object.keys(rawFilesDelta).length > 0;
      if (Object.keys(nextFiles).length > 0) latestFilesRef.current = nextFiles;

      if (sendingRef.current) {
        const pending = pendingUpdateRef.current;
        pendingUpdateRef.current =
          pending && !pending.filesOnly && filesOnly
            ? { ...pending, files: nextFiles }
            : { elements, files: nextFiles, filesOnly };
        return shouldSyncFiles;
      }

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
          if (isSameRejectedFileAttempt(previousAttempt, file)) {
            rejectedFileIds.add(fileId);
            return false;
          }
          rejectedFileAttemptsRef.current.delete(fileId);
          return true;
        }),
      );

      let filePayloads = splitFilesIntoUpdatePayloads({ drawingId, files: deliverableFiles });
      while (!filePayloads.ok) {
        const rejectedFile = deliverableFiles[filePayloads.fileId];
        // This is a local refusal marker, not a delivery marker. Keeping the
        // exact rejected content separate from lastSyncedFilesRef prevents it
        // from blocking every later update without ever claiming server ACK.
        rejectedFileAttemptsRef.current.set(filePayloads.fileId, rejectedFileAttempt(rejectedFile));
        rejectedFileIds.add(filePayloads.fileId);
        toast.error(
          `File ${filePayloads.fileId} is too large for live collaboration (${filePayloads.payloadBytes} bytes)`,
        );
        delete deliverableFiles[filePayloads.fileId];
        filePayloads = splitFilesIntoUpdatePayloads({ drawingId, files: deliverableFiles });
      }

      const changes = candidateChanges.filter(
        (element) => !referencesRejectedFile(element, rejectedFileIds),
      );
      const shouldDeliverOrder =
        shouldSyncOrder &&
        !normalizedElements.some((element) => referencesRejectedFile(element, rejectedFileIds));

      const packets: DeliveryPacket[] = filePayloads.payloads.map((payload) => ({
        payload,
        acknowledge: () => {
          lastSyncedFilesRef.current = {
            ...lastSyncedFilesRef.current,
            ...payload.files,
          };
        },
      }));

      if (changes.length > 0 || shouldDeliverOrder) {
        const elementOrder = shouldDeliverOrder
          ? normalizedElements
              .filter((element: any) => !element?.isDeleted)
              .map((element: any) => element?.id)
              .filter((id): id is string => Boolean(id))
          : undefined;
        const orderBytes = elementOrder ? elementOrderByteLength(elementOrder) : 0;
        packets.push({
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
            if (shouldDeliverOrder && nextOrderSig !== undefined) {
              lastSyncedElementOrderSigRef.current = nextOrderSig;
            }
          },
        });
      }

      if (packets.length > 0) {
        setHasSceneChangesSinceLoad();
        lastLocalChangeAtRef.current = Date.now();
      }

      if (!filesOnly && (packets.length > 0 || settingsChanged)) {
        const appState = latestAppStateRef.current;
        if (appState) {
          if (settingsChanged) {
            lastPersistedAppStateSigRef.current = boardSettingsSignature(appState);
          }
          debouncedSave(drawingId, normalizedElements, appState, nextFiles);
          debouncedSavePreview(drawingId);
        }
      }

      if (packets.length === 0) return false;
      sendingRef.current = true;
      deliverPackets(packets, (delivered) => {
        sendingRef.current = false;
        const pending = pendingUpdateRef.current;
        pendingUpdateRef.current = null;
        if (delivered && pending) {
          queueUpdateRef.current(pending.elements, pending.files, pending.filesOnly);
        }
      });
      return true;
    },
    [
      computeElementOrderSig,
      files,
      debouncedSave,
      debouncedSavePreview,
      deliverPackets,
      drawingId,
      hasElementChanged,
      lastLocalChangeAtRef,
      lastPersistedAppStateSigRef,
      lastSyncedElementOrderSigRef,
      lastSyncedFilesRef,
      latestAppStateRef,
      latestFilesRef,
      normalizeImageElementStatus,
      recordElementVersion,
      setHasSceneChangesSinceLoad,
      socketRef,
    ],
  );
  useEffect(() => {
    queueUpdateRef.current = queueUpdate;
  }, [queueUpdate]);

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
      sendingRef.current = false;
      pendingUpdateRef.current = null;
      if (throttleTimeoutRef.current !== null) {
        window.clearTimeout(throttleTimeoutRef.current);
      }
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current);
      }
    },
    [],
  );

  return { broadcastChanges, broadcastFiles };
};
