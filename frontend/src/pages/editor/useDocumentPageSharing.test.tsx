import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDocumentPageSharing } from "./useDocumentPageSharing";

describe("requesting an authoritative document page", () => {
  it("sends no client-selected asset id and resolves the server ack", async () => {
    const emit = vi.fn((_event, _payload, ack) => ack(null, { ok: true }));
    const socket = { timeout: vi.fn(() => ({ emit })) };
    const socketRef = { current: socket as any };
    const { result } = renderHook(() =>
      useDocumentPageSharing({ drawingId: "board-1", socketRef }),
    );

    let response: unknown;
    await act(async () => {
      response = await result.current.controller.requestPage("widget-1", 4);
    });

    expect(socket.timeout).toHaveBeenCalledWith(5_000);
    expect(emit).toHaveBeenCalledWith(
      "document-page-command",
      { drawingId: "board-1", elementId: "widget-1", page: 4 },
      expect.any(Function),
    );
    expect(response).toEqual({ ok: true });
  });

  it("turns a missing acknowledgement into a machine-readable timeout", async () => {
    const socket = {
      timeout: () => ({
        emit: (_event: string, _payload: unknown, ack: (error: Error) => void) =>
          ack(new Error("timeout")),
      }),
    };
    const { result } = renderHook(() =>
      useDocumentPageSharing({ drawingId: "board-1", socketRef: { current: socket as any } }),
    );

    await expect(result.current.controller.requestPage("widget-1", 4)).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });
});
