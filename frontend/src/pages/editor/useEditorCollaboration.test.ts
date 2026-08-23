import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

const mocks = vi.hoisted(() => ({
  resetConnectionState: null as (() => void) | null,
  roomLifecycleInput: null as any,
  remoteSelectionPublish: vi.fn(),
  socket: {
    connected: false,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock("socket.io-client", () => ({ io: () => mocks.socket }));
vi.mock("../../api", () => ({ getShareLinkToken: () => null }));
vi.mock("./socketRoomLifecycle", () => ({
  bindSocketRoomLifecycle: (input: { resetConnectionState: () => void }) => {
    mocks.roomLifecycleInput = input;
    mocks.resetConnectionState = input.resetConnectionState;
    return vi.fn();
  },
}));
vi.mock("./followMode", () => ({
  bindFollowMode: () => Object.assign(vi.fn(), { resetConnectionState: vi.fn() }),
  getFollowInterruptionMessage: () => "follow interrupted",
}));
vi.mock("./cursorChat", () => ({
  startCursorChat: () => ({
    controller: { pruneTo: vi.fn(), dispose: vi.fn() },
    prunePeers: vi.fn(),
    decorateName: (name: string) => name,
  }),
}));
vi.mock("./socketCollaborators", () => ({
  bindSocketCollaborators: () => ({
    refresh: vi.fn(),
    reset: vi.fn(),
    setSelfPresenceId: vi.fn(),
    dispose: vi.fn(),
  }),
}));
vi.mock("./remoteSelection", () => ({
  bindRemoteSelection: () => ({
    reset: vi.fn(),
    publish: mocks.remoteSelectionPublish,
    dispose: vi.fn(),
  }),
}));
vi.mock("./workshopTimer", () => ({
  createIdleWorkshopTimerSnapshot: () => ({}),
  bindSocketWorkshopTimer: () => ({ reset: vi.fn(), dispose: vi.fn() }),
  WORKSHOP_TIMER_COMMAND_EVENT: "workshop-timer-command",
}));
vi.mock("./useDocumentPageSharing", () => ({
  useDocumentPageSharing: () => ({
    controller: {},
    bind: () => ({ reset: vi.fn(), dispose: vi.fn() }),
  }),
}));
vi.mock("./inviteHere", () => ({
  bindInviteHere: () => ({
    reset: vi.fn(),
    dispose: vi.fn(),
    invite: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
  }),
}));
vi.mock("./wheelZoom", () => ({ bindCanvasWheelZoom: () => vi.fn() }));

import { useEditorCollaboration } from "./useEditorCollaboration";

const ref = <T>(value: T) => ({ current: value }) as MutableRefObject<T>;

describe("editor collaboration reconnect state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.resetConnectionState = null;
    mocks.roomLifecycleInput = null;
    vi.clearAllMocks();
  });

  it("publishes the adapter selection when the room join completes", () => {
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: ref<any>({
          getAppState: () => ({ selectedElementIds: { selected: true } }),
        }),
        editorContainerRef: ref<HTMLDivElement | null>(null),
        lastSyncedFilesRef: ref({}),
        lastSyncedElementOrderSigRef: ref("order"),
        latestElementsRef: ref([]),
        latestFilesRef: ref({}),
        computeElementOrderSig: () => "order",
        recordElementVersion: vi.fn(),
        onAccessDenied: vi.fn(),
        onDrawingNameChange: vi.fn(),
      }),
    );

    act(() =>
      mocks.roomLifecycleInput.onJoined({
        presenceId: "presence-1",
        name: "User",
        color: "#000",
      }),
    );

    expect(mocks.remoteSelectionPublish).toHaveBeenCalledWith(["selected"]);
    unmount();
  });

  it("adds remote files through the file capability and keeps them out of the raw scene write", () => {
    let flush: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        flush = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const addFiles = vi.fn();
    const updateScene = vi.fn();
    const file = {
      id: "file-1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,bytes",
      created: 1,
    };
    const element = { id: "element-1", version: 1, versionNonce: 1, updated: 1 };
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: ref<any>({
          getAppState: () => ({}),
          getSceneElementsIncludingDeleted: () => [],
          updateScene,
          addFiles,
        }),
        editorContainerRef: ref<HTMLDivElement | null>(null),
        lastSyncedFilesRef: ref({}),
        lastSyncedElementOrderSigRef: ref("order"),
        latestElementsRef: ref([]),
        latestFilesRef: ref({}),
        computeElementOrderSig: () => "order",
        recordElementVersion: vi.fn(),
        onAccessDenied: vi.fn(),
        onDrawingNameChange: vi.fn(),
      }),
    );
    const elementUpdate = mocks.socket.on.mock.calls.find(
      ([event]) => event === "element-update",
    )?.[1];

    act(() => elementUpdate({ elements: [element], files: { "file-1": file } }));
    act(() => flush?.(0));

    expect(addFiles).toHaveBeenCalledWith([file]);
    expect(updateScene).toHaveBeenCalledWith({
      elements: [element],
      captureUpdate: "NEVER",
    });
    expect(updateScene.mock.calls[0][0]).not.toHaveProperty("files");
    unmount();
  });

  it("reports and retries a file capability failure without marking the file as synced", () => {
    let flush: FrameRequestCallback | null = null;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = {
      id: "file-1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,bytes",
      created: 1,
    };
    const apiRef = ref<any>(null);
    apiRef.current = {
      getAppState: () => ({}),
      getSceneElementsIncludingDeleted: () => {
        apiRef.current = null;
        return [];
      },
      updateScene: vi.fn(),
      addFiles: vi.fn(),
    };
    const lastSyncedFilesRef = ref<Record<string, any>>({});
    const latestFilesRef = ref<Record<string, any>>({});
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: apiRef,
        editorContainerRef: ref<HTMLDivElement | null>(null),
        lastSyncedFilesRef,
        lastSyncedElementOrderSigRef: ref("order"),
        latestElementsRef: ref([]),
        latestFilesRef,
        computeElementOrderSig: () => "order",
        recordElementVersion: vi.fn(),
        onAccessDenied: vi.fn(),
        onDrawingNameChange: vi.fn(),
      }),
    );
    const elementUpdate = mocks.socket.on.mock.calls.find(
      ([event]) => event === "element-update",
    )?.[1];

    act(() => elementUpdate({ elements: [], files: { "file-1": file } }));
    act(() => flush?.(0));

    expect(error).toHaveBeenCalledWith("Live collaboration could not update the editor.");
    expect(lastSyncedFilesRef.current).toEqual({});
    expect(latestFilesRef.current).toEqual({});
    expect(requestFrame).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("reports a follow-state capability failure through the collaboration toast channel", () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: ref<any>(null),
        editorContainerRef: ref<HTMLDivElement | null>(null),
        lastSyncedFilesRef: ref({}),
        lastSyncedElementOrderSigRef: ref("order"),
        latestElementsRef: ref([]),
        latestFilesRef: ref({}),
        computeElementOrderSig: () => "order",
        recordElementVersion: vi.fn(),
        onAccessDenied: vi.fn(),
        onDrawingNameChange: vi.fn(),
      }),
    );

    expect(mocks.roomLifecycleInput.getFollowTargetPresenceId()).toBeNull();
    expect(error).toHaveBeenCalledWith("Live collaboration could not update the editor.");
    expect(warn).toHaveBeenCalledWith(
      "[Editor] Excalidraw capability failed:",
      expect.objectContaining({
        ok: false,
        code: "not-ready",
        seam: "collaboration.readFollowState",
      }),
    );
    unmount();
  });

  it("forgets confirmed file markers when the room lifecycle resets for reconnect", () => {
    const confirmedFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,bytes" },
    };
    const lastSyncedFilesRef = ref<Record<string, any>>(confirmedFiles);
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: ref<any>({
          getAppState: () => ({ collaborators: new Map() }),
          getSceneElementsIncludingDeleted: () => [],
          getFiles: () => confirmedFiles,
          updateScene: vi.fn(),
          addFiles: vi.fn(),
        }),
        editorContainerRef: ref<HTMLDivElement | null>(null),
        lastSyncedFilesRef,
        lastSyncedElementOrderSigRef: ref("order"),
        latestElementsRef: ref([]),
        latestFilesRef: ref(confirmedFiles),
        computeElementOrderSig: () => "order",
        recordElementVersion: vi.fn(),
        onAccessDenied: vi.fn(),
        onDrawingNameChange: vi.fn(),
      }),
    );

    expect(mocks.resetConnectionState).toBeTypeOf("function");
    act(() => mocks.resetConnectionState?.());

    expect(lastSyncedFilesRef.current).toEqual({});
    unmount();
  });
});
