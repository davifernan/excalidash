import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import { useEditorBroadcast } from "./useEditorBroadcast";
import { boardSettingsSignature } from "./shared";
import { computeElementOrderSig } from "./useEditorElementTracking";

const ref = <T>(value: T) => ({ current: value }) as MutableRefObject<T>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editor broadcast delivery tracking", () => {
  it("reports a file capability failure instead of treating missing files as an empty read", () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: {
          read: () => ({ ok: false, code: "not-ready", seam: "files.read" }),
        } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit: vi.fn() }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current.broadcastChanges([]));

    expect(error).toHaveBeenCalledWith("Live collaboration could not read editor files.");
  });

  it("does not mark element versions or ordering as sent until the server acknowledges them", () => {
    let acknowledge: ((value: any) => void) | undefined;
    const emit = vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
      acknowledge = ack;
    });
    const orderRef = ref("old-order");
    const recordElementVersion = vi.fn();
    const element = { id: "element-1", version: 2 };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: orderRef,
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "new-order",
        hasElementChanged: (element) =>
          !recordElementVersion.mock.calls.some(([recorded]) => recorded === element),
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion,
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current.broadcastChanges([element], {}));

    expect(recordElementVersion).not.toHaveBeenCalled();
    expect(orderRef.current).toBe("old-order");
    expect(acknowledge).toBeTypeOf("function");

    act(() => acknowledge?.({ ok: true }));

    expect(recordElementVersion).toHaveBeenCalledWith(element);
    expect(orderRef.current).toBe("new-order");
  });

  it("retries unacknowledged element content instead of losing it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const acknowledgements: Array<(value: any) => void> = [];
    const emit = vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
      if (ack) acknowledgements.push(ack);
    });
    const element = { id: "element-1", version: 2 };
    let sent = false;
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => !sent,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: () => {
          sent = true;
        },
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current.broadcastChanges([element], {}));
    act(() => acknowledgements[0]?.({ ok: false, error: { code: "invalid-request" } }));
    vi.advanceTimersByTime(101);
    act(() => result.current.broadcastChanges([element], {}));

    expect(emit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("keeps unrelated changes flowing after rejecting an oversized file without marking it sent", () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    const acknowledgements: Array<(value: any) => void> = [];
    const emit = vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
      if (ack) acknowledgements.push(ack);
    });
    const lastSyncedFilesRef = ref<Record<string, any>>({});
    const recordElementVersion = vi.fn();
    const oversizedFile = {
      id: "oversized",
      dataURL: `data:image/png;base64,${"x".repeat(10 * 1024 * 1024)}`,
    };
    const files = { oversized: oversizedFile };
    const rejectedImage = {
      id: "rejected-image",
      type: "image",
      fileId: "oversized",
      x: 124.4,
      y: 387.6,
      version: 2,
    };
    const unrelatedElement = { id: "unrelated-shape", type: "rectangle", version: 2 };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: files }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef,
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: (element) =>
          !recordElementVersion.mock.calls.some(([recorded]) => recorded === element),
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion,
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => expect(result.current.broadcastFiles(files)).toBe(false));
    expect(lastSyncedFilesRef.current).toEqual({});
    expect(emit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    act(() => result.current.broadcastChanges([rejectedImage, unrelatedElement], files));

    expect(error).toHaveBeenCalledWith(
      "Image near canvas position (124, 388) is too large for live collaboration (10.0 MB).",
    );
    expect(error.mock.calls.flat().join(" ")).not.toContain("oversized");

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      elements: [unrelatedElement],
    });
    expect(emit.mock.calls[0][1]).not.toHaveProperty("files");
    expect(lastSyncedFilesRef.current).toEqual({});

    act(() => acknowledgements[0]?.({ ok: true }));

    expect(recordElementVersion).toHaveBeenCalledOnce();
    expect(recordElementVersion).toHaveBeenCalledWith(unrelatedElement);
    expect(recordElementVersion).not.toHaveBeenCalledWith(rejectedImage);
    expect(lastSyncedFilesRef.current).toEqual({});

    const resizedFile = { ...oversizedFile, dataURL: "data:image/png;base64,resized" };
    act(() => expect(result.current.broadcastFiles({ oversized: resizedFile })).toBe(true));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1]).toMatchObject({
      elements: [],
      files: { oversized: resizedFile },
    });
    expect(lastSyncedFilesRef.current).toEqual({});

    act(() => acknowledgements[1]?.({ ok: true }));
    expect(lastSyncedFilesRef.current).toEqual({ oversized: resizedFile });
  });

  it("automatically retries when the socket acknowledgement window expires", () => {
    vi.useFakeTimers();
    const acknowledgements: Array<(error: unknown, response?: unknown) => void> = [];
    const emit = vi.fn(
      (_event: string, _payload: unknown, ack: (error: unknown, response?: unknown) => void) => {
        acknowledgements.push(ack);
      },
    );
    const socket = {
      timeout: vi.fn(() => ({ emit })),
    };
    const recordElementVersion = vi.fn();
    const element = { id: "element-1", version: 2 };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>(socket),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => recordElementVersion.mock.calls.length === 0,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion,
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current.broadcastChanges([element], {}));
    act(() => acknowledgements[0]?.(new Error("timeout")));

    expect(recordElementVersion).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_000));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(recordElementVersion).not.toHaveBeenCalled();

    act(() => acknowledgements[1]?.(null, { ok: true }));

    expect(recordElementVersion).toHaveBeenCalledTimes(1);
    expect(recordElementVersion).toHaveBeenCalledWith(element);
    vi.useRealTimers();
  });

  it("lets a fresh file use the delivery slot while an older file waits to retry", () => {
    vi.useFakeTimers();
    const acknowledgements: Array<(response?: unknown) => void> = [];
    let disconnect: (() => void) | undefined;
    const emit = vi.fn((_event: string, _payload: unknown, ack: (response?: unknown) => void) => {
      acknowledgements.push(ack);
    });
    const socket = {
      connected: true,
      emit,
      once: vi.fn((_event: string, listener: () => void) => {
        disconnect = listener;
      }),
      off: vi.fn(),
    };
    const roomJoinedRef = ref(true);
    const largeFile = { id: "large", mimeType: "image/png", dataURL: "data:large" };
    const smallFile = { id: "small", mimeType: "image/png", dataURL: "data:small" };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        roomJoinedRef,
        socketRef: ref<any>(socket),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => expect(result.current.broadcastFiles({ large: largeFile })).toBe(true));
    expect(emit.mock.calls[0][1]).toMatchObject({ files: { large: largeFile } });

    socket.connected = false;
    roomJoinedRef.current = false;
    act(() => disconnect?.());
    act(() => vi.advanceTimersByTime(1_000));
    act(() =>
      expect(
        result.current.broadcastFiles({
          large: { ...largeFile, lastRetrieved: 1 },
          small: smallFile,
        }),
      ).toBe(true),
    );

    expect(emit).toHaveBeenCalledOnce();
    socket.connected = true;
    roomJoinedRef.current = true;
    act(() => vi.advanceTimersByTime(100));
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1]).toMatchObject({ files: { small: smallFile } });
    expect(emit.mock.calls[1][1]).not.toHaveProperty("files.large");
    vi.useRealTimers();
  });

  it("waits for the room join acknowledgement before delivering queued files", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const socket = { connected: false, emit };
    const roomJoinedRef = ref(false);
    const queuedFile = { id: "queued", mimeType: "image/png", dataURL: "data:queued" };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        roomJoinedRef,
        socketRef: ref<any>(socket),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => expect(result.current.broadcastFiles({ queued: queuedFile })).toBe(true));
    act(() => vi.advanceTimersByTime(100));
    expect(emit).not.toHaveBeenCalled();

    socket.connected = true;
    act(() => vi.advanceTimersByTime(100));
    expect(emit).not.toHaveBeenCalled();

    roomJoinedRef.current = true;
    act(() => vi.advanceTimersByTime(100));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][1]).toMatchObject({ files: { queued: queuedFile } });
    vi.useRealTimers();
  });

  it("batches queued files up to the live update limits", () => {
    const emit = vi.fn();
    const firstFile = { id: "first", mimeType: "image/png", dataURL: "data:first" };
    const secondFile = { id: "second", mimeType: "image/png", dataURL: "data:second" };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() =>
      expect(result.current.broadcastFiles({ first: firstFile, second: secondFile })).toBe(true),
    );

    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][1]).toMatchObject({
      elements: [],
      files: { first: firstFile, second: secondFile },
    });
  });

  it("requeues a newer file version when the in-flight version is hard rejected", () => {
    const acknowledgements: Array<(response?: unknown) => void> = [];
    const emit = vi.fn((_event: string, _payload: unknown, ack: (response?: unknown) => void) => {
      acknowledgements.push(ack);
    });
    const firstVersion = { id: "replaceable", dataURL: "data:first-version" };
    const secondVersion = { id: "replaceable", dataURL: "data:second-version" };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current.broadcastFiles({ replaceable: firstVersion }));
    act(() => result.current.broadcastFiles({ replaceable: secondVersion }));
    expect(emit).toHaveBeenCalledOnce();

    act(() =>
      acknowledgements[0]?.({
        ok: false,
        error: { code: "invalid-request", message: "old version rejected" },
      }),
    );

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1]).toMatchObject({ files: { replaceable: secondVersion } });
  });

  it("keeps scene updates ordered while the first update retries", () => {
    vi.useFakeTimers();
    const acknowledgements: Array<(error: unknown, response?: unknown) => void> = [];
    const emit = vi.fn(
      (_event: string, _payload: unknown, ack: (error: unknown, response?: unknown) => void) => {
        acknowledgements.push(ack);
      },
    );
    const socket = { timeout: vi.fn(() => ({ emit })) };
    const first = { id: "first", version: 1 };
    const second = { id: "second", version: 1 };
    const recordElementVersion = vi.fn();
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("old-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>(socket),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: (elements) => elements.map((element) => element.id).join(","),
        hasElementChanged: (element) => !recordElementVersion.mock.calls.flat().includes(element),
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion,
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current.broadcastChanges([first], {}));
    act(() => acknowledgements[0]?.(new Error("offline")));
    act(() => vi.advanceTimersByTime(101));
    act(() => result.current.broadcastChanges([first, second], {}));

    expect(emit).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1]).toMatchObject({ elements: [first] });

    act(() => acknowledgements[1]?.(null, { ok: true }));
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[2][1]).toMatchObject({ elements: [second] });
    vi.useRealTimers();
  });

  it.each([
    {
      name: "an added element",
      pendingSnapshots: [
        [
          { id: "first", version: 1 },
          { id: "changing", version: 1, isDeleted: false },
        ],
        [
          { id: "first", version: 1 },
          { id: "changing", version: 2, isDeleted: false },
        ],
      ],
      expected: { id: "changing", version: 2, isDeleted: false },
    },
    {
      name: "a deletion tombstone",
      pendingSnapshots: [
        [
          { id: "first", version: 1 },
          { id: "changing", version: 1, isDeleted: false },
        ],
        [
          { id: "first", version: 1 },
          { id: "changing", version: 2, isDeleted: true },
        ],
      ],
      expected: { id: "changing", version: 2, isDeleted: true },
    },
    {
      name: "an element that is deleted and then restored",
      pendingSnapshots: [
        [
          { id: "first", version: 1 },
          { id: "changing", version: 1, isDeleted: false },
        ],
        [
          { id: "first", version: 1 },
          { id: "changing", version: 2, isDeleted: true },
        ],
        [
          { id: "first", version: 1 },
          { id: "changing", version: 3, isDeleted: false },
        ],
      ],
      expected: { id: "changing", version: 3, isDeleted: false },
    },
  ])(
    "coalesces pending full-scene snapshots without losing $name",
    ({ pendingSnapshots, expected }) => {
      vi.useFakeTimers();
      const acknowledgements: Array<(error: unknown, response?: unknown) => void> = [];
      const emit = vi.fn(
        (_event: string, _payload: unknown, ack: (error: unknown, response?: unknown) => void) => {
          acknowledgements.push(ack);
        },
      );
      const first = { id: "first", version: 1 };
      const { result } = renderHook(() =>
        useEditorBroadcast({
          drawingId: "drawing-1",
          files: { read: () => ({ ok: true, value: {} }) } as any,
          lastLocalChangeAtRef: ref(0),
          lastSyncedElementOrderSigRef: ref("old-order"),
          lastSyncedFilesRef: ref({}),
          latestAppStateRef: ref(null),
          latestFilesRef: ref({}),
          lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
          socketRef: ref<any>({ timeout: vi.fn(() => ({ emit })) }),
          debouncedSave: vi.fn(),
          debouncedSavePreview: vi.fn(),
          computeElementOrderSig: (elements) => elements.map((element) => element.id).join(","),
          hasElementChanged: () => true,
          normalizeImageElementStatus: (elements) => elements,
          recordElementVersion: vi.fn(),
          setHasSceneChangesSinceLoad: vi.fn(),
        }),
      );

      act(() => result.current.broadcastChanges([first], {}));
      for (const snapshot of pendingSnapshots) {
        act(() => vi.advanceTimersByTime(101));
        act(() => result.current.broadcastChanges(snapshot, {}));
      }
      act(() => acknowledgements[0]?.(null, { ok: true }));

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1][1]).toMatchObject({ elements: expect.arrayContaining([expected]) });
      vi.useRealTimers();
    },
  );

  it.each([
    { code: "rate-limited", expectedEmits: 2 },
    { code: "access-denied", expectedEmits: 1 },
  ])("retries only retryable acknowledgement errors ($code)", ({ code, expectedEmits }) => {
    vi.useFakeTimers();
    const acknowledgements: Array<(error: unknown, response?: unknown) => void> = [];
    const emit = vi.fn(
      (_event: string, _payload: unknown, ack: (error: unknown, response?: unknown) => void) => {
        acknowledgements.push(ack);
      },
    );
    const socket = {
      timeout: vi.fn(() => ({ emit })),
    };
    const recordElementVersion = vi.fn();
    const orderRef = ref("old-order");
    const element = { id: "element-1", version: 2 };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: orderRef,
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>(socket),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "new-order",
        hasElementChanged: () => recordElementVersion.mock.calls.length === 0,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion,
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current.broadcastChanges([element], {}));
    act(() =>
      acknowledgements[0]?.(null, {
        ok: false,
        error: { code, message: `${code} response` },
      }),
    );
    act(() => vi.advanceTimersByTime(1_000));

    expect(emit).toHaveBeenCalledTimes(expectedEmits);
    expect(recordElementVersion).not.toHaveBeenCalled();
    expect(orderRef.current).toBe("old-order");
    vi.useRealTimers();
  });

  it("does not let deleted elements inflate ordering payloads", () => {
    let payload: any;
    const emit = vi.fn((_event: string, value: unknown) => {
      payload = value;
    });
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("old-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "new-order",
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() =>
      result.current.broadcastChanges([{ id: "visible" }, { id: "deleted", isDeleted: true }], {}),
    );

    expect(payload.elementOrder).toEqual(["visible"]);
    expect(computeElementOrderSig([{ id: "visible" }, { id: "deleted", isDeleted: true }])).toBe(
      computeElementOrderSig([{ id: "deleted", isDeleted: true }, { id: "visible" }]),
    );
  });
});

describe("saving the settings a board keeps", () => {
  // Broadcasting is throttled to one run per 100ms. Without moving the clock
  // between calls the later ones are merged away, and a test that meant to
  // prove "written once" would prove only "throttled".
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = () => act(() => void vi.advanceTimersByTime(200));

  const harness = (
    appState: MutableRefObject<any>,
    orderSig = "same-order",
    // What the board arrived with. Set once the scene has hydrated, so opening
    // a board writes nothing back.
    settingsBaseline: MutableRefObject<string | null> = ref(
      boardSettingsSignature(appState.current),
    ),
  ) => {
    const debouncedSave = vi.fn();
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        files: { read: () => ({ ok: true, value: {} }) } as any,
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref(orderSig),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: appState,
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: settingsBaseline,
        socketRef: ref<any>({ emit: vi.fn() }),
        debouncedSave,
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => orderSig,
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );
    return { broadcast: result.current.broadcastChanges, debouncedSave };
  };

  it("writes a settings change that touches no element", () => {
    // Turning snapping off changes appState and nothing else: no element, no
    // file, no ordering. While the ordering signature was never initialised on
    // load, the first change of a session always looked like an ordering change
    // and carried the settings along by accident. Once that was fixed, the
    // setting stopped being saved and came back on the next reload.
    const appState = ref<any>({ objectsSnapModeEnabled: true });
    const { broadcast, debouncedSave } = harness(appState);

    act(() => broadcast([], {}));
    settle();

    appState.current = { objectsSnapModeEnabled: false };
    act(() => broadcast([], {}));

    expect(debouncedSave).toHaveBeenCalledTimes(1);
    expect(debouncedSave.mock.calls[0][2]).toEqual({ objectsSnapModeEnabled: false });
  });

  it("writes nothing back when a board is merely opened", () => {
    // Excalidraw reports a change of its own once a scene has hydrated. If that
    // counted as a settings change, every open would save the board unchanged:
    // a new version and a fresh modified date for everybody in it, because
    // somebody looked at it.
    const appState = ref<any>({ objectsSnapModeEnabled: true });
    const { broadcast, debouncedSave } = harness(appState);

    act(() => broadcast([], {}));
    settle();
    act(() => broadcast([], {}));
    settle();

    expect(debouncedSave).not.toHaveBeenCalled();
  });

  it("does not write again while the settings stand still", () => {
    const appState = ref<any>({ objectsSnapModeEnabled: true });
    const { broadcast, debouncedSave } = harness(appState);

    appState.current = { objectsSnapModeEnabled: false };
    act(() => broadcast([], {}));
    settle();
    act(() => broadcast([], {}));
    settle();
    act(() => broadcast([], {}));
    settle();

    // Once, for the change itself. Panning and clicking about must not keep
    // writing the same settings back.
    expect(debouncedSave).toHaveBeenCalledTimes(1);
  });
});

describe("getDeliveryState", () => {
  const params = (overrides: Record<string, unknown>) => ({
    drawingId: "drawing-1",
    files: { read: () => ({ ok: true, value: {} }) } as any,
    lastLocalChangeAtRef: ref(0),
    lastSyncedElementOrderSigRef: ref("same-order"),
    lastSyncedFilesRef: ref<Record<string, any>>({}),
    latestAppStateRef: ref(null),
    latestFilesRef: ref({}),
    lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
    debouncedSave: vi.fn(),
    debouncedSavePreview: vi.fn(),
    computeElementOrderSig: () => "same-order",
    hasElementChanged: () => true,
    normalizeImageElementStatus: (elements: readonly any[]) => elements,
    recordElementVersion: vi.fn(),
    setHasSceneChangesSinceLoad: vi.fn(),
    ...overrides,
  });

  it("reports a file as in flight until the server acks it, then as acknowledged", () => {
    const acknowledgements: Array<(value: any) => void> = [];
    const emit = vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
      if (ack) acknowledgements.push(ack);
    });
    const file = { id: "file-1", dataURL: "data:image/png;base64,abc" };
    const { result } = renderHook(() =>
      useEditorBroadcast(params({ socketRef: ref<any>({ emit }) })),
    );

    expect(result.current.getDeliveryState()).toEqual({
      inFlight: false,
      parked: false,
      retrying: false,
      acknowledgedFileIds: [],
      rejectedFileIds: [],
    });

    act(() => result.current.broadcastFiles({ "file-1": file }));
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: true,
      acknowledgedFileIds: [],
    });

    act(() => acknowledgements[0]?.({ ok: true }));
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: false,
      parked: false,
      acknowledgedFileIds: ["file-1"],
    });
  });

  it("does not retransmit a file merely because its ack waits behind main-thread work", () => {
    vi.useFakeTimers();
    const acknowledgements: Array<(response?: unknown) => void> = [];
    const emit = vi.fn((_event: string, _payload: unknown, ack: (response?: unknown) => void) => {
      acknowledgements.push(ack);
    });
    const socket = {
      emit,
      timeout: vi.fn((milliseconds: number) => ({
        emit: (_event: string, _payload: unknown, ack: (error: unknown) => void) =>
          window.setTimeout(() => ack(new Error("timeout")), milliseconds),
      })),
    };
    const file = { id: "file-1", dataURL: "data:image/png;base64,abc" };
    const { result } = renderHook(() =>
      useEditorBroadcast(params({ socketRef: ref<any>(socket) })),
    );

    act(() => result.current.broadcastFiles({ "file-1": file }));
    act(() => vi.advanceTimersByTime(10_000));

    expect(emit).toHaveBeenCalledOnce();
    expect(socket.timeout).not.toHaveBeenCalled();
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: true,
      retrying: false,
      acknowledgedFileIds: [],
    });

    act(() => acknowledgements[0]?.({ ok: true }));
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: false,
      acknowledgedFileIds: ["file-1"],
    });
    vi.useRealTimers();
  });

  it("reports queue state while a fresh file passes a disconnected retry", () => {
    vi.useFakeTimers();
    const acknowledgements: Array<(response?: unknown) => void> = [];
    let disconnect: (() => void) | undefined;
    const emit = vi.fn((_event: string, _payload: unknown, ack: (response?: unknown) => void) => {
      acknowledgements.push(ack);
    });
    const socket = {
      emit,
      once: vi.fn((_event: string, listener: () => void) => {
        disconnect = listener;
      }),
      off: vi.fn(),
    };
    const first = { id: "file-1", dataURL: "data:image/png;base64,first" };
    const second = { id: "file-2", dataURL: "data:image/png;base64,second" };
    const { result } = renderHook(() =>
      useEditorBroadcast(params({ socketRef: ref<any>(socket) })),
    );

    act(() => result.current.broadcastFiles({ "file-1": first }));
    act(() => result.current.broadcastFiles({ "file-1": first, "file-2": second }));
    expect(result.current.getDeliveryState()).toMatchObject({ inFlight: true, parked: true });

    act(() => disconnect?.());
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: true,
      parked: false,
      retrying: true,
      acknowledgedFileIds: [],
    });

    // NIL-533's fairness contract: the fresh second file takes the free lane
    // while the first file waits for its retry delay.
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[1]).toMatchObject({ files: { "file-2": second } });

    act(() => acknowledgements[1]?.({ ok: true }));
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: false,
      parked: false,
      retrying: true,
      acknowledgedFileIds: ["file-2"],
    });

    act(() => vi.advanceTimersByTime(1_000));
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[2]?.[1]).toMatchObject({ files: { "file-1": first } });
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: true,
      parked: false,
      retrying: true,
    });

    act(() => acknowledgements[2]?.({ ok: true }));
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: false,
      parked: false,
      retrying: false,
      acknowledgedFileIds: ["file-2", "file-1"],
    });
    vi.useRealTimers();
  });

  it("reports a locally rejected oversized file, and never as acknowledged", () => {
    const emit = vi.fn();
    const files = {
      oversized: {
        id: "oversized",
        dataURL: `data:image/png;base64,${"x".repeat(12 * 1024 * 1024)}`,
      },
    };
    const { result } = renderHook(() =>
      useEditorBroadcast(
        params({
          socketRef: ref<any>({ emit }),
          files: { read: () => ({ ok: true, value: files }) } as any,
        }),
      ),
    );

    act(() => result.current.broadcastFiles(files));

    expect(emit).not.toHaveBeenCalled();
    expect(result.current.getDeliveryState()).toMatchObject({
      inFlight: false,
      rejectedFileIds: ["oversized"],
      acknowledgedFileIds: [],
    });
  });

  it("reports a pending oversized image when the board changes before its element appears", () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    const files = {
      oversized: {
        id: "oversized",
        dataURL: `data:image/png;base64,${"x".repeat(12 * 1024 * 1024)}`,
      },
    };
    const { result, rerender } = renderHook(
      ({ drawingId }) =>
        useEditorBroadcast(
          params({
            drawingId,
            socketRef: ref<any>({ emit: vi.fn() }),
            files: { read: () => ({ ok: true, value: files }) } as any,
          }),
        ),
      { initialProps: { drawingId: "drawing-1" } },
    );

    act(() => result.current.broadcastFiles(files));
    expect(error).not.toHaveBeenCalled();

    rerender({ drawingId: "drawing-2" });

    expect(error).toHaveBeenCalledWith(
      "An image from the previous board is too large for live collaboration (12.0 MB).",
    );
    expect(error.mock.calls.flat().join(" ")).not.toContain("oversized");
  });
});
