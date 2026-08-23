import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});
