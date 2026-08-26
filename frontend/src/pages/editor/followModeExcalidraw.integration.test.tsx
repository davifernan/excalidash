import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { describe, expect, it, vi } from "vitest";
import { bindFollowMode } from "./followMode";

vi.hoisted(() => {
  class TestPath2D {}
  (globalThis as any).Path2D = TestPath2D;
  class TestFontFace {
    status = "loaded";
    constructor(readonly family: string) {}
    load() {
      return Promise.resolve(this);
    }
  }
  (globalThis as any).FontFace = TestFontFace;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(() => true),
      check: vi.fn(() => true),
      ready: Promise.resolve(),
    },
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    const base = {
      canvas: this,
      filter: "none",
      font: "",
      measureText: (text: string) => ({
        width: text.length * 8,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
      }),
    };
    return new Proxy(base, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return vi.fn();
      },
      set(target, property, value) {
        (target as any)[property] = value;
        return true;
      },
    });
  }) as any;
});

describe("follow correction with the real Excalidraw API", () => {
  it("starts and replaces the same Excalidraw follow intent used by avatar clicks", async () => {
    let api: any;
    const view = render(
      <div style={{ width: 900, height: 600 }}>
        <Excalidraw
          excalidrawAPI={(value) => {
            api = value;
          }}
        />
      </div>,
    );
    await waitFor(() => expect(api).toBeDefined());
    await act(async () => {
      api.updateScene({
        appState: {
          collaborators: new Map([
            ["target-socket", { socketId: "target-socket", username: "Target" }],
            ["newest-target", { socketId: "newest-target", username: "Newest" }],
          ]),
        },
      });
    });

    const socket = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const cleanup = bindFollowMode({
      socket: socket as any,
      drawingId: "drawing-1",
      api,
      container: null,
      onFollowersChange: vi.fn(),
    });

    await act(async () => cleanup.follow("target-socket"));

    await waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith("follow-user", {
        drawingId: "drawing-1",
        targetPresenceId: "target-socket",
        action: "FOLLOW",
      }),
    );
    expect(api.getAppState().userToFollow?.socketId).toBe("target-socket");

    await act(async () => cleanup.follow("newest-target"));
    await waitFor(() => expect(api.getAppState().userToFollow?.socketId).toBe("newest-target"));
    expect(socket.emit).toHaveBeenLastCalledWith("follow-user", {
      drawingId: "drawing-1",
      targetPresenceId: "newest-target",
      action: "FOLLOW",
    });
    expect(socket.emit.mock.calls.filter(([event]) => event === "follow-user")).toEqual([
      [
        "follow-user",
        { drawingId: "drawing-1", targetPresenceId: "target-socket", action: "FOLLOW" },
      ],
      [
        "follow-user",
        { drawingId: "drawing-1", targetPresenceId: "newest-target", action: "FOLLOW" },
      ],
    ]);

    cleanup();
    view.unmount();
  });

  it("does not echo the real onUserFollow callbacks caused by updateScene", async () => {
    let api: any;
    const view = render(
      <div style={{ width: 900, height: 600 }}>
        <Excalidraw
          excalidrawAPI={(value) => {
            api = value;
          }}
        />
      </div>,
    );
    await waitFor(() => expect(api).toBeDefined());

    await act(async () => {
      api.updateScene({
        appState: {
          collaborators: new Map([
            [
              "rejected-target",
              {
                socketId: "rejected-target",
                username: "Rejected",
              },
            ],
            [
              "target-socket",
              {
                socketId: "target-socket",
                username: "Target",
              },
            ],
          ]),
          userToFollow: {
            socketId: "rejected-target",
            username: "Rejected",
          },
        },
      });
    });
    await waitFor(() => expect(api.getAppState().userToFollow?.socketId).toBe("rejected-target"));

    const handlers = new Map<string, (payload: any) => void>();
    const socket = {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (payload: any) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
    };
    const cleanup = bindFollowMode({
      socket: socket as any,
      drawingId: "drawing-1",
      api,
      container: null,
      onFollowersChange: vi.fn(),
    });

    await act(async () => {
      handlers.get("follow-status")?.({
        drawingId: "drawing-1",
        followingPresenceId: "target-socket",
        reason: "rate-limited",
      });
    });
    await waitFor(() => expect(api.getAppState().userToFollow?.socketId).toBe("target-socket"));

    expect(socket.emit).not.toHaveBeenCalledWith("follow-user", expect.anything());
    cleanup();
    view.unmount();
  });
});
