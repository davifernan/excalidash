import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notification = vi.hoisted(() => vi.fn());
vi.mock("../../notifications", () => ({ notify: notification }));

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
    confirmRoomJoined: vi.fn(),
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
import { openSceneDocument } from "../../integrations/excalidraw/adapter";

const ref = <T>(value: T) => ({ current: value }) as MutableRefObject<T>;
const capabilities = (overrides: Record<string, any> = {}) => ({
  collaboration: {
    readFollowState: vi.fn(() => ({
      ok: true,
      value: { followingSocketId: null, followedBySocketIds: [] },
    })),
  },
  files: { add: vi.fn(() => ({ ok: true, value: undefined })) },
  interaction: {
    read: vi.fn(() => ({
      ok: true,
      value: {
        editingTextElementId: null,
        editingTextContainerId: null,
        resizingElementId: null,
        creatingElementId: null,
        activeTool: { type: "selection" },
      },
    })),
  },
  scene: { apply: vi.fn(() => ({ ok: true, value: undefined })) },
  selection: {
    read: vi.fn(() => ({ ok: true, value: { selectedIds: [], allSelected: false } })),
  },
  viewport: {
    subscribeScroll: vi.fn(() => () => {}),
    visibleBounds: vi.fn(() => ({ ok: true, value: [0, 0, 100, 100] })),
    showBounds: vi.fn(() => ({
      ok: true,
      value: {
        viewport: {
          zoom: 1,
          scrollX: 0,
          scrollY: 0,
          offsetLeft: 0,
          offsetTop: 0,
          width: 0,
          height: 0,
        },
        bounds: [0, 0, 100, 100],
        zoomClamped: false,
      },
    })),
  },
  ...overrides,
});

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
        ...capabilities({
          selection: {
            read: vi.fn(() => ({
              ok: true,
              value: { selectedIds: ["selected"], allSelected: false },
            })),
          },
        }),
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
    const addFiles = vi.fn(() => ({ ok: true, value: undefined }));
    const sceneApply = vi.fn(() => ({ ok: true, value: undefined }));
    const file = {
      id: "file-1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,bytes",
      created: 1,
    };
    const element = { id: "element-1", version: 1, versionNonce: 1, updated: 1 };
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        ...capabilities({ files: { add: addFiles }, scene: { apply: sceneApply } }),
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: ref<any>({
          getAppState: () => ({}),
          getSceneElementsIncludingDeleted: () => [],
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
    expect(sceneApply).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "replaceDocument" })],
      { capture: "never" },
    );
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
        ...capabilities({
          files: {
            add: vi.fn(() => ({ ok: false, code: "not-ready", seam: "files.add" })),
          },
        }),
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

    expect(notification).toHaveBeenCalledWith(
      "error",
      "Live collaboration could not update the editor.",
    );
    expect(lastSyncedFilesRef.current).toEqual({});
    expect(latestFilesRef.current).toEqual({});
    expect(requestFrame).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("reports and retries a rejected remote scene write", () => {
    let flush: FrameRequestCallback | null = null;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const latestElementsRef = ref<readonly any[]>([]);
    const latestFilesRef = ref<Record<string, any>>({});
    const lastSyncedFilesRef = ref<Record<string, any>>({});
    const file = {
      id: "file-1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,bytes",
      created: 1,
    };
    const sceneApply = vi.fn(() => ({
      ok: false,
      code: "editor-changed",
      seam: "scene.apply",
    }));
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        ...capabilities({ scene: { apply: sceneApply } }),
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: ref<any>({}),
        editorContainerRef: ref<HTMLDivElement | null>(null),
        lastSyncedFilesRef,
        lastSyncedElementOrderSigRef: ref("order"),
        latestElementsRef,
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

    act(() =>
      elementUpdate({
        elements: [{ id: "element-1", version: 1 }],
        files: { "file-1": file },
      }),
    );
    act(() => flush?.(0));

    expect(sceneApply).toHaveBeenCalled();
    expect(notification).toHaveBeenCalledWith(
      "error",
      "Live collaboration could not update the editor.",
    );
    expect(latestElementsRef.current).toEqual([]);
    expect(latestFilesRef.current).toEqual({});
    expect(lastSyncedFilesRef.current).toEqual({});
    expect(requestFrame).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("reports a follow-state capability failure through the notification facade", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        ...capabilities({
          collaboration: {
            readFollowState: vi.fn(() => ({
              ok: false,
              code: "not-ready",
              seam: "collaboration.readFollowState",
            })),
          },
        }),
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
    expect(notification).toHaveBeenCalledWith(
      "error",
      "Live collaboration could not update the editor.",
    );
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      message: "[Editor] Excalidraw capability failed",
      failure: {
        ok: false,
        code: "not-ready",
        seam: "collaboration.readFollowState",
      },
    });
    unmount();
  });

  it("keeps cursor rate-limit protection internal without hiding actionable rate limits", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        ...capabilities(),
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
    const roomEventError = mocks.socket.on.mock.calls.find(
      ([event]) => event === "room-event-error",
    )?.[1];

    act(() =>
      roomEventError({
        event: "cursor-move",
        error: { code: "rate-limited", message: "cursor-move rate limit exceeded" },
      }),
    );

    expect(notification).not.toHaveBeenCalled();

    act(() =>
      roomEventError({
        event: "document-page-command",
        error: {
          code: "rate-limited",
          message: "document-page-command rate limit exceeded",
        },
      }),
    );

    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith("info", "document-page-command rate limit exceeded");
    unmount();
  });

  it("limits a rapid pointer stream to twenty cursor emissions per second", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result, unmount } = renderHook(() =>
      useEditorCollaboration({
        ...capabilities(),
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

    act(() => {
      for (let millisecond = 0; millisecond < 1_000; millisecond += 1) {
        now = 1_000 + millisecond;
        result.current.onPointerUpdate({
          pointer: { x: millisecond, y: millisecond },
          button: "down",
        });
      }
    });

    const cursorEmits = mocks.socket.emit.mock.calls.filter(([event]) => event === "cursor-move");
    expect(cursorEmits).toHaveLength(20);
    expect(cursorEmits[0][1]).toMatchObject({
      drawingId: "drawing-1",
      pointer: { x: 0, y: 0 },
    });
    unmount();
  });

  it("keeps confirmed file markers when the room lifecycle resets for reconnect", () => {
    const confirmedFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,bytes" },
    };
    const lastSyncedFilesRef = ref<Record<string, any>>(confirmedFiles);
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        ...capabilities(),
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

    expect(lastSyncedFilesRef.current).toBe(confirmedFiles);
    unmount();
  });

  // NIL-591: connectionStatus is the chrome's one source of truth for
  // "connected" vs "reconnecting" vs "offline" -- it must track the same
  // authoritative signals bindSocketRoomLifecycle already uses (onJoined,
  // resetConnectionState), not merely `socket.connected`.
  describe("connectionStatus", () => {
    // Built once, outside the render callback: an inline `capabilities()` /
    // `() => "order"` recreated on every render feeds fresh references into
    // the hook's own effect dependency array, and a churned-but-still-live
    // socket re-run re-derives `roomJoinedRef.current = false` at its top
    // for what is, from the outside, still the same live connection --
    // exactly the false "reconnecting" this status exists to not show.
    // Stable props are what an actual caller (Editor.tsx, memoised via
    // useCallback) already provides; this mirrors that rather than
    // papering over it with more production code.
    const stableProps = {
      ...capabilities(),
      drawingId: "drawing-1",
      me: { id: "user-1", name: "User", initials: "U", color: "#000" },
      isReady: true,
      excalidrawAPI: ref<any>({ getAppState: () => ({ selectedElementIds: {} }) }),
      editorContainerRef: ref<HTMLDivElement | null>(null),
      lastSyncedFilesRef: ref({}),
      lastSyncedElementOrderSigRef: ref("order"),
      latestElementsRef: ref([]),
      latestFilesRef: ref({}),
      computeElementOrderSig: () => "order",
      recordElementVersion: vi.fn(),
      onAccessDenied: vi.fn(),
      onDrawingNameChange: vi.fn(),
    };
    const renderCollaboration = () => renderHook(() => useEditorCollaboration(stableProps));

    it("starts reconnecting, not connected, before the room join acks", () => {
      const { result, unmount } = renderCollaboration();
      expect(result.current.connectionStatus).toBe("reconnecting");
      unmount();
    });

    it("becomes connected only once the room join actually completes", () => {
      const { result, unmount } = renderCollaboration();

      act(() =>
        mocks.roomLifecycleInput.onJoined({
          presenceId: "presence-1",
          name: "User",
          color: "#000",
        }),
      );

      expect(result.current.connectionStatus).toBe("connected");
      unmount();
    });

    it("falls back to reconnecting when the connection resets after being connected", () => {
      const { result, unmount } = renderCollaboration();

      act(() =>
        mocks.roomLifecycleInput.onJoined({
          presenceId: "presence-1",
          name: "User",
          color: "#000",
        }),
      );
      expect(result.current.connectionStatus).toBe("connected");

      act(() => mocks.resetConnectionState?.());
      expect(result.current.connectionStatus).toBe("reconnecting");
      unmount();
    });

    it("shows offline, not reconnecting, when the browser reports no network", () => {
      const { result, unmount } = renderCollaboration();

      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      act(() => window.dispatchEvent(new Event("offline")));
      expect(result.current.connectionStatus).toBe("offline");

      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
      act(() => window.dispatchEvent(new Event("online")));
      expect(result.current.connectionStatus).toBe("reconnecting");

      unmount();
    });

    it("does not downgrade an already-connected room to reconnecting on a spurious online event", () => {
      const { result, unmount } = renderCollaboration();

      act(() =>
        mocks.roomLifecycleInput.onJoined({
          presenceId: "presence-1",
          name: "User",
          color: "#000",
        }),
      );
      expect(result.current.connectionStatus).toBe("connected");

      act(() => window.dispatchEvent(new Event("online")));
      expect(result.current.connectionStatus).toBe("connected");

      unmount();
    });
  });
});

describe("NIL-690 same-content echo (through the real flush path, not the isolated helper)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.resetConnectionState = null;
    mocks.roomLifecycleInput = null;
    vi.clearAllMocks();
  });

  it("keeps the previous bookkeeping when a remote update is content-identical to what is already live", () => {
    let flush: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        flush = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const sceneApply = vi.fn(() => ({ ok: true, value: undefined }));
    const previous = {
      id: "el-1",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      angle: 0,
      isDeleted: false,
      version: 5,
      versionNonce: 100,
      updated: 1000,
    };
    // Bookkeeping bumped, every content field identical -- exactly the
    // "late echo" shape from NIL-690's own finding.
    const echoed = { ...previous, version: 6, versionNonce: 200, updated: 2000 };
    const { unmount } = renderHook(() =>
      useEditorCollaboration({
        ...capabilities({ scene: { apply: sceneApply } }),
        drawingId: "drawing-1",
        me: { id: "user-1", name: "User", initials: "U", color: "#000" },
        isReady: true,
        excalidrawAPI: ref<any>({
          getAppState: () => ({}),
          getSceneElementsIncludingDeleted: () => [previous],
          addFiles: vi.fn(),
        }),
        editorContainerRef: ref<HTMLDivElement | null>(null),
        lastSyncedFilesRef: ref({}),
        lastSyncedElementOrderSigRef: ref("order"),
        latestElementsRef: ref([previous]),
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

    act(() => elementUpdate({ elements: [echoed], files: {} }));
    act(() => flush?.(0));

    expect(sceneApply).toHaveBeenCalledTimes(1);
    const [ops] = sceneApply.mock.calls[0]!;
    const document = openSceneDocument((ops[0] as any).document)!;
    const applied = document.elements.find((el: any) => el.id === "el-1");
    // The whole point: the previous, lower version survives -- not the
    // echo's bumped one. Reverting the fix's wiring (while leaving
    // `preserveUnchangedElements` itself untouched in utils/sync.ts) makes
    // this assertion fail, because nothing left in the flush path would
    // call it any more -- see this test's own file comment.
    expect(applied.version).toBe(5);
    expect(applied.versionNonce).toBe(100);
    expect(applied.updated).toBe(1000);

    unmount();
  });
});
