import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { compressExcalidrawFiles } from "../../utils/imageCompression";
import { getFilesDelta } from "./shared";
import { useEditorPersistence } from "./useEditorPersistence";

vi.mock("../../api", () => ({
  getDrawing: vi.fn(),
  updateDrawing: vi.fn(),
  updateLibrary: vi.fn(),
  isAxiosError: vi.fn().mockReturnValue(false),
}));

vi.mock("../../utils/imageCompression", () => ({
  compressExcalidrawFiles: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  exportToSvg: vi.fn(),
}));

const ref = <T>(current: T) => ({ current });

const createRefs = (files: Record<string, any>, lastSyncedFiles: Record<string, any> = {}) => ({
  currentDrawingVersion: ref<number | null>(1),
  debouncedSave: ref<any>(null),
  excalidrawAPI: ref({
    addFiles: vi.fn(),
    getAppState: vi.fn().mockReturnValue(null),
    updateScene: vi.fn(),
  }),
  isSyncing: ref(false),
  isUnmounting: ref(false),
  lastLocalChangeAt: ref(0),
  lastPersistedElements: ref<readonly any[]>([]),
  lastPersistedFiles: ref<Record<string, any>>({}),
  lastSyncedFiles: ref(lastSyncedFiles),
  latestAppState: ref<any>(null),
  latestElements: ref<readonly any[]>([]),
  latestFiles: ref<any>(files),
  saveQueue: ref(Promise.resolve()),
  suspiciousBlankLoad: ref(false),
});

const renderPersistence = (refs: ReturnType<typeof createRefs>) =>
  renderHook(() =>
    useEditorPersistence({
      refs,
      user: null,
      normalizeImageElementStatus: (elements) => elements || [],
      resolveSafeSnapshot: (elements) => ({
        snapshot: elements || [],
        prevented: false,
        staleEmptySnapshot: false,
        staleNonRenderableSnapshot: false,
      }),
    }),
  );

describe("useEditorPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.isAxiosError).mockReturnValue(false);
  });

  it("keeps a failed save visible to the next file delta", async () => {
    const previouslySyncedFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,previous" },
    };
    const editorFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,unsaved" },
    };
    const compressedFiles = {
      image: { id: "image", dataURL: "data:image/webp;base64,compressed" },
    };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: compressedFiles,
      changed: true,
      changedIds: ["image"],
    });
    vi.mocked(api.updateDrawing).mockRejectedValueOnce(new Error("save rejected"));
    const refs = createRefs(editorFiles, previouslySyncedFiles);
    const { result } = renderPersistence(refs);

    await act(async () => {
      await expect(
        result.current.saveDataRef.current?.(
          "drawing",
          [{ id: "element", type: "image", fileId: "image" }],
          {},
          editorFiles,
        ),
      ).rejects.toThrow("save rejected");
    });

    expect(refs.lastSyncedFiles.current).toBe(previouslySyncedFiles);
    expect(getFilesDelta(refs.lastSyncedFiles.current, editorFiles)).toEqual({
      image: editorFiles.image,
    });
  });

  it("does not book the baseline after the bounded conflict retry fails", async () => {
    const previouslySyncedFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,previous" },
    };
    const editorFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,unsaved" },
    };
    const compressedFiles = {
      image: { id: "image", dataURL: "data:image/webp;base64,compressed" },
    };
    const conflict = { response: { status: 409 } };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: compressedFiles,
      changed: true,
      changedIds: ["image"],
    });
    vi.mocked(api.isAxiosError).mockImplementation((error) => error === conflict);
    vi.mocked(api.updateDrawing).mockRejectedValue(conflict);
    vi.mocked(api.getDrawing).mockResolvedValue({
      version: 2,
      elements: [],
      files: {},
    } as any);
    const refs = createRefs(editorFiles, previouslySyncedFiles);
    const { result } = renderPersistence(refs);

    await act(async () => {
      await expect(
        result.current.saveDataRef.current?.(
          "drawing",
          [{ id: "element", type: "image", fileId: "image" }],
          {},
          editorFiles,
        ),
      ).rejects.toThrow("Drawing version conflict");
    });

    expect(api.getDrawing).toHaveBeenCalledTimes(1);
    expect(api.updateDrawing).toHaveBeenCalledTimes(2);
    expect(refs.lastSyncedFiles.current).toBe(previouslySyncedFiles);
  });

  it("keeps the editor file map as the sync baseline after compression", async () => {
    const editorFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,original" },
    };
    const compressedFiles = {
      image: { id: "image", dataURL: "data:image/webp;base64,compressed" },
    };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: compressedFiles,
      changed: true,
      changedIds: ["image"],
    });
    vi.mocked(api.updateDrawing).mockResolvedValue({
      version: 2,
      files: compressedFiles,
    } as any);

    const refs = createRefs(editorFiles);
    const { result } = renderPersistence(refs);

    await act(async () => {
      await result.current.saveDataRef.current?.(
        "drawing",
        [{ id: "element", type: "image", fileId: "image" }],
        {},
        editorFiles,
      );
    });

    expect(api.updateDrawing).toHaveBeenCalledWith(
      "drawing",
      expect.objectContaining({ files: compressedFiles }),
    );
    expect(refs.excalidrawAPI.current.addFiles).toHaveBeenCalledWith(
      Object.values(compressedFiles),
    );
    expect(refs.latestFiles.current).toBe(compressedFiles);
    expect(refs.lastPersistedFiles.current).toBe(compressedFiles);
    expect(refs.lastSyncedFiles.current).toBe(editorFiles);
    expect(getFilesDelta(refs.lastSyncedFiles.current, editorFiles)).toEqual({});
  });
});
