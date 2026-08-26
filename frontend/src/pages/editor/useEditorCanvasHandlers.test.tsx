import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const notification = vi.hoisted(() => vi.fn());
vi.mock("../../notifications", () => ({ notify: notification }));

vi.mock("./droppedImages", () => ({
  getDroppedImageFiles: (dataTransfer: any) => Array.from(dataTransfer?.files || []),
  loadDroppedImageData: async (file: any) => ({
    fileId: file.name,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,bytes",
    created: 1,
    width: 100,
    height: 100,
  }),
  MULTI_IMAGE_DROP_GAP: 24,
}));

import { useEditorCanvasHandlers } from "./useEditorCanvasHandlers";

describe("editor canvas capability failures", () => {
  it("does not treat a failed files.read as an empty successful read", () => {
    const fileCapability = {
      read: vi.fn(() => ({
        ok: false,
        code: "editor-changed",
        seam: "files.read",
      })),
    } as any;
    const api = {
      getFiles: () => ({}),
      getSceneElementsIncludingDeleted: () => [{ id: "element", type: "rectangle" }],
    };
    const ref = <T,>(current: T) => ({ current });
    const { result } = renderHook(() =>
      useEditorCanvasHandlers({
        canEdit: true,
        canUploadFiles: true,
        debouncedSavePreview: vi.fn(),
        drawingId: "drawing-1",
        emitFilesDeltaIfNeeded: vi.fn(),
        fileCapability,
        isReady: false,
        refs: {
          excalidrawAPI: ref(api),
          hasHydratedInitialScene: ref(true),
          hasSceneChangesSinceLoad: ref(false),
          initialSceneElements: ref<readonly any[]>([]),
          isBootstrappingScene: ref(false),
          isHistoryPreviewing: ref(false),
          isSyncing: ref(false),
          isUnmounting: ref(false),
          lastLocalChangeAt: ref(0),
          lastPersistedAppStateSig: ref<string | null>(null),
          latestAppState: ref({}),
          latestElements: ref<readonly any[]>([]),
          latestFiles: ref({}),
          debouncedSave: ref(null),
          suspiciousBlankLoad: ref(false),
        },
        resolveSafeSnapshot: () => ({
          prevented: false,
          staleEmptySnapshot: false,
          staleNonRenderableSnapshot: false,
        }),
        scene: {} as any,
        viewport: {} as any,
        broadcastChanges: vi.fn(),
      }),
    );

    expect(() => result.current.handleCanvasChange([], {}, undefined)).toThrow(
      "files.read failed (editor-changed)",
    );
  });

  it("keeps the import error visible when the scene rejects a multi-image drop", async () => {
    const ref = <T,>(current: T) => ({ current });
    const scene = {
      apply: vi.fn(() => ({
        ok: false,
        code: "editor-changed",
        seam: "scene.apply",
      })),
    } as any;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    notification.mockClear();
    const { result } = renderHook(() =>
      useEditorCanvasHandlers({
        canEdit: true,
        canUploadFiles: true,
        debouncedSavePreview: vi.fn(),
        drawingId: "drawing-1",
        emitFilesDeltaIfNeeded: vi.fn(),
        fileCapability: {
          add: vi.fn(() => ({ ok: true, value: undefined })),
          read: vi.fn(() => ({ ok: true, value: {} })),
        } as any,
        isReady: false,
        refs: {
          excalidrawAPI: ref({}),
          hasHydratedInitialScene: ref(true),
          hasSceneChangesSinceLoad: ref(false),
          initialSceneElements: ref<readonly any[]>([]),
          isBootstrappingScene: ref(false),
          isHistoryPreviewing: ref(false),
          isSyncing: ref(false),
          isUnmounting: ref(false),
          lastLocalChangeAt: ref(0),
          lastPersistedAppStateSig: ref<string | null>(null),
          latestAppState: ref({}),
          latestElements: ref<readonly any[]>([{ id: "existing", type: "rectangle" }]),
          latestFiles: ref({}),
          debouncedSave: ref(null),
          suspiciousBlankLoad: ref(false),
        },
        resolveSafeSnapshot: () => ({
          prevented: false,
          staleEmptySnapshot: false,
          staleNonRenderableSnapshot: false,
        }),
        scene,
        viewport: {
          toScene: vi.fn(() => ({ ok: true, value: { x: 100, y: 100 } })),
        } as any,
        broadcastChanges: vi.fn(),
      }),
    );
    const event = {
      clientX: 100,
      clientY: 100,
      dataTransfer: {
        files: [
          { name: "one.png", type: "image/png" },
          { name: "two.png", type: "image/png" },
        ],
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as any;

    await result.current.handleCanvasDropCapture(event);

    expect(scene.apply).toHaveBeenCalled();
    const logged = JSON.parse(error.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      message: "[Editor] Failed to import dropped images",
      error: { message: "scene.apply failed (editor-changed)" },
    });
    expect(notification).toHaveBeenCalledWith("error", "Failed to import dropped images");
    error.mockRestore();
  });
});
