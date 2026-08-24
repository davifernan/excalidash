import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { useEditorFileUploads } from "./useEditorFileUploads";

vi.mock("../../api", () => ({ uploadDrawingFile: vi.fn() }));

const mockUpload = vi.mocked(api.uploadDrawingFile);

/** A minimal FileCapability backed by a plain map, matching the real contract's shape. */
const makeFileCapability = (files: Record<string, { mimeType: string; dataURL: string }>) => ({
  read: () => ({ ok: true as const, value: files }),
  add: vi.fn(() => ({ ok: true as const, value: undefined })),
  deltaAgainst: (confirmed: ReadonlySet<string>) => ({
    ok: true as const,
    value: Object.entries(files)
      .filter(([id]) => !confirmed.has(id))
      .map(([id, file]) => ({ id, created: 0, ...file })),
  }),
  onFilesAdded: vi.fn((listener: () => void) => {
    listenersRef.push(listener);
    return () => {
      listenersRef = listenersRef.filter((l) => l !== listener);
    };
  }),
});
let listenersRef: Array<() => void> = [];

const fireFilesAdded = () => listenersRef.forEach((listener) => listener());

beforeEach(() => {
  vi.useFakeTimers();
  listenersRef = [];
  mockUpload.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useEditorFileUploads", () => {
  it("uploads a newly-added embedded file after the flush interval, not immediately", async () => {
    const fileCapability = makeFileCapability({
      "file-1": { mimeType: "image/png", dataURL: "data:image/png;base64,aaaa" },
    });
    mockUpload.mockResolvedValue(undefined);
    renderHook(() => useEditorFileUploads({ drawingId: "d1", fileCapability: fileCapability as any }));

    act(() => fireFilesAdded());
    expect(mockUpload).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mockUpload).toHaveBeenCalledWith("d1", "file-1", "data:image/png;base64,aaaa", "image/png");
  });

  it("marks a file uploaded only after the PUT resolves, not merely after it is sent", async () => {
    const fileCapability = makeFileCapability({
      "file-1": { mimeType: "image/png", dataURL: "data:image/png;base64,aaaa" },
    });
    let resolveUpload!: () => void;
    mockUpload.mockReturnValue(new Promise<void>((resolve) => (resolveUpload = resolve)));
    const { result } = renderHook(() =>
      useEditorFileUploads({ drawingId: "d1", fileCapability: fileCapability as any }),
    );

    act(() => fireFilesAdded());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    // In flight, not yet acked.
    expect(result.current.hasUploadedFile("file-1" as any)).toBe(false);

    await act(async () => {
      resolveUpload();
      await Promise.resolve();
    });
    expect(result.current.hasUploadedFile("file-1" as any)).toBe(true);
  });

  it("does not mark a failed upload as uploaded, so the next flush retries it", async () => {
    const fileCapability = makeFileCapability({
      "file-1": { mimeType: "image/png", dataURL: "data:image/png;base64,aaaa" },
    });
    mockUpload.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() =>
      useEditorFileUploads({ drawingId: "d1", fileCapability: fileCapability as any }),
    );

    act(() => fireFilesAdded());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(result.current.hasUploadedFile("file-1" as any)).toBe(false);

    // The failure schedules a follow-up flush (scheduleFlush in .finally()).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(result.current.hasUploadedFile("file-1" as any)).toBe(true);
  });

  it("never uploads a file whose dataURL is already a server reference", async () => {
    const fileCapability = makeFileCapability({
      "file-1": { mimeType: "image/png", dataURL: "/api/files/d1/file-1" },
    });
    renderHook(() => useEditorFileUploads({ drawingId: "d1", fileCapability: fileCapability as any }));

    act(() => fireFilesAdded());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("uploads at most UPLOAD_CONCURRENCY files per flush", async () => {
    const fileCapability = makeFileCapability({
      "file-1": { mimeType: "image/png", dataURL: "data:image/png;base64,a" },
      "file-2": { mimeType: "image/png", dataURL: "data:image/png;base64,b" },
      "file-3": { mimeType: "image/png", dataURL: "data:image/png;base64,c" },
      "file-4": { mimeType: "image/png", dataURL: "data:image/png;base64,d" },
    });
    mockUpload.mockImplementation(() => new Promise(() => {})); // never resolves
    renderHook(() => useEditorFileUploads({ drawingId: "d1", fileCapability: fileCapability as any }));

    act(() => fireFilesAdded());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mockUpload).toHaveBeenCalledTimes(3);
  });
});
