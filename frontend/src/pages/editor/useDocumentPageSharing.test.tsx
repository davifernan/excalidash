import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDocumentPageSharing } from "./useDocumentPageSharing";

describe("requesting an authoritative document page", () => {
  it("sends no client-selected asset id and resolves the server ack", async () => {
    const emit = vi.fn((_event, _payload, ack) => ack({ ok: true }));
    const socket = { connected: true, emit, on: vi.fn(), off: vi.fn() };
    const socketRef = { current: socket as any };
    const { result } = renderHook(() =>
      useDocumentPageSharing({ drawingId: "board-1", socketRef }),
    );

    let response: unknown;
    await act(async () => {
      response = await result.current.controller.requestPage("widget-1", 4);
    });

    expect(emit).toHaveBeenCalledWith(
      "document-page-command",
      { drawingId: "board-1", elementId: "widget-1", page: 4 },
      expect.any(Function),
    );
    expect(response).toEqual({ ok: true });
  });

  it("does not start the retry clock until an offline socket reconnects", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const acknowledgements: Array<(response: unknown) => void> = [];
    const socket = {
      connected: false,
      emit: vi.fn((_event, _payload, ack) => acknowledgements.push(ack)),
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
    };
    const { result } = renderHook(() =>
      useDocumentPageSharing({ drawingId: "board-1", socketRef: { current: socket as any } }),
    );

    const response = result.current.controller.requestPage("widget-1", 4);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.emit).not.toHaveBeenCalled();

    socket.connected = true;
    listeners.get("connect")?.();
    expect(socket.emit).toHaveBeenCalledOnce();
    acknowledgements[0]?.({ ok: false, error: { code: "gone", message: "Widget is gone" } });

    await expect(response).resolves.toEqual({
      ok: false,
      error: { code: "gone", message: "Widget is gone" },
    });
    vi.useRealTimers();
  });

  it("keeps a slow real acknowledgement alive while retrying", async () => {
    vi.useFakeTimers();
    const acknowledgements: Array<(response: unknown) => void> = [];
    const socket = {
      connected: true,
      emit: vi.fn((_event, _payload, ack) => acknowledgements.push(ack)),
      on: vi.fn(),
      off: vi.fn(),
    };
    const { result } = renderHook(() =>
      useDocumentPageSharing({ drawingId: "board-1", socketRef: { current: socket as any } }),
    );

    const response = result.current.controller.requestPage("widget-1", 4);
    expect(socket.emit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.emit).toHaveBeenCalledTimes(2);

    acknowledgements[0]?.({
      ok: false,
      error: { code: "document-widget-not-found", message: "Document widget is gone" },
    });
    await expect(response).resolves.toEqual({
      ok: false,
      error: { code: "document-widget-not-found", message: "Document widget is gone" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.emit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
