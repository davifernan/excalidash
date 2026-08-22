import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { boardSettingsSignature } from "./shared";
import { useEditorAddFilesBridge } from "./useEditorAddFilesBridge";
import { useEditorBroadcast } from "./useEditorBroadcast";

const ref = <T>(value: T) => ({ current: value }) as MutableRefObject<T>;

const renderDeliveryBridge = ({
  lastSyncedFilesRef,
  socket,
}: {
  lastSyncedFilesRef: MutableRefObject<Record<string, any>>;
  socket: any;
}) => {
  const latestFilesRef = ref<Record<string, any>>({});
  return renderHook(() => {
    const broadcast = useEditorBroadcast({
      drawingId: "drawing-1",
      excalidrawAPI: ref<any>({ getFiles: () => latestFilesRef.current }),
      lastLocalChangeAtRef: ref(0),
      lastSyncedElementOrderSigRef: ref("same-order"),
      lastSyncedFilesRef,
      latestAppStateRef: ref(null),
      latestFilesRef,
      lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
      socketRef: ref(socket),
      debouncedSave: vi.fn(),
      debouncedSavePreview: vi.fn(),
      computeElementOrderSig: () => "same-order",
      hasElementChanged: () => false,
      normalizeImageElementStatus: (elements) => elements,
      recordElementVersion: vi.fn(),
      setHasSceneChangesSinceLoad: vi.fn(),
    });
    const broadcastFiles =
      typeof (broadcast as any) === "function"
        ? (files: Record<string, any>) => (broadcast as any)([], files)
        : (broadcast as any).broadcastFiles;

    return useEditorAddFilesBridge({
      drawingId: "drawing-1",
      debouncedSaveRef: ref(null),
      excalidrawAPIRef: ref(null),
      hasSceneChangesSinceLoadRef: ref(false),
      isHistoryPreviewingRef: ref(false),
      isSyncingRef: ref(false),
      latestAppStateRef: ref(null),
      latestElementsRef: ref([]),
      latestFilesRef,
      setIsReady: vi.fn(),
      broadcastFiles,
      // These two fields describe the broken pre-fix bridge. Keeping them in
      // the regression harness makes the same assertion fail against that
      // implementation while the repaired bridge ignores the bypass entirely.
      socketRef: ref(socket),
      lastSyncedFilesRef,
    } as any);
  });
};

describe("add-files collaboration delivery", () => {
  it("keeps the confirmed file baseline unchanged until a positive acknowledgement", () => {
    const acknowledgements: Array<(value: any) => void> = [];
    const socket = {
      emit: vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
        if (ack) acknowledgements.push(ack);
      }),
    };
    const previousFiles = { existing: { id: "existing", dataURL: "data:image/png;base64,a" } };
    const lastSyncedFilesRef = ref<Record<string, any>>(previousFiles);
    const nextFiles = {
      ...previousFiles,
      added: { id: "added", dataURL: "data:image/png;base64,b" },
    };
    const { result } = renderDeliveryBridge({ lastSyncedFilesRef, socket });

    act(() => {
      expect(result.current.emitFilesDeltaIfNeeded(nextFiles)).toBe(true);
    });

    expect(lastSyncedFilesRef.current).toBe(previousFiles);
    expect(acknowledgements).toHaveLength(1);

    act(() => {
      acknowledgements[0]({
        ok: false,
        error: { code: "access-denied", message: "Access denied" },
      });
    });

    expect(lastSyncedFilesRef.current).toBe(previousFiles);
  });

  it("splits file-only updates before they cross the safe live-update boundary", () => {
    const acknowledgements: Array<(value: any) => void> = [];
    const socket = {
      emit: vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
        if (ack) acknowledgements.push(ack);
      }),
    };
    const lastSyncedFilesRef = ref<Record<string, any>>({});
    const sixMiB = 6 * 1024 * 1024;
    const files = {
      first: { id: "first", dataURL: `data:image/png;base64,${"a".repeat(sixMiB)}` },
      second: { id: "second", dataURL: `data:image/png;base64,${"b".repeat(sixMiB)}` },
    };
    const { result } = renderDeliveryBridge({ lastSyncedFilesRef, socket });

    act(() => {
      expect(result.current.emitFilesDeltaIfNeeded(files)).toBe(true);
    });

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(Object.keys(socket.emit.mock.calls[0][1].files)).toEqual(["first"]);

    act(() => acknowledgements[0]({ ok: true }));

    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(Object.keys(socket.emit.mock.calls[1][1].files)).toEqual(["second"]);
  });

  it("rejects one indivisible oversized file before it reaches the socket", () => {
    const socket = { emit: vi.fn() };
    const lastSyncedFilesRef = ref<Record<string, any>>({});
    const files = {
      oversized: {
        id: "oversized",
        dataURL: `data:image/png;base64,${"x".repeat(12 * 1024 * 1024)}`,
      },
    };
    const { result } = renderDeliveryBridge({ lastSyncedFilesRef, socket });

    act(() => {
      expect(result.current.emitFilesDeltaIfNeeded(files)).toBe(false);
    });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(lastSyncedFilesRef.current).toEqual({});
  });
});
