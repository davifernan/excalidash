import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resetConnectionState: null as (() => void) | null,
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
  bindSocketRoomLifecycle: ({ resetConnectionState }: { resetConnectionState: () => void }) => {
    mocks.resetConnectionState = resetConnectionState;
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
  bindRemoteSelection: () => ({ reset: vi.fn(), publish: vi.fn(), dispose: vi.fn() }),
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
    mocks.resetConnectionState = null;
    vi.clearAllMocks();
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
      }),
    );

    expect(mocks.resetConnectionState).toBeTypeOf("function");
    act(() => mocks.resetConnectionState?.());

    expect(lastSyncedFilesRef.current).toEqual({});
    unmount();
  });
});
