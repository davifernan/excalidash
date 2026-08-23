import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { navigate, toast } = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast }));

import { useEditorCommands } from "./useEditorCommands";

describe("editor command capability failures", () => {
  it("keeps the existing back-navigation error toast when files.read fails", async () => {
    const boardSettings = {
      read: vi.fn(() => ({
        ok: true,
        value: {
          gridModeEnabled: false,
          gridSize: null,
          gridStep: null,
          objectsSnapModeEnabled: false,
          viewBackgroundColor: "#ffffff",
          theme: "light",
        },
      })),
    } as any;
    const files = {
      read: vi.fn(() => ({
        ok: false,
        code: "editor-changed",
        seam: "files.read",
      })),
    } as any;
    const enqueueSceneSave = vi.fn().mockResolvedValue(undefined);
    const savePreview = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const getSceneElementsIncludingDeleted = vi.fn(() => [{ id: "raw-element" }]);
    const refs = {
      excalidrawAPI: {
        current: {
          getSceneElementsIncludingDeleted,
          getAppState: () => ({}),
          getFiles: () => ({}),
        },
      },
      hasSceneChangesSinceLoad: { current: true },
      latestElements: { current: [{ id: "element" }] },
      latestFiles: { current: {} },
      saveData: { current: vi.fn() },
      savePreview: { current: savePreview },
      suspiciousBlankLoad: { current: false },
    };

    const { result } = renderHook(() =>
      useEditorCommands({
        boardSettings,
        canEdit: true,
        debouncedSaveLibrary: vi.fn(),
        drawingId: "drawing-1",
        drawingName: "Board",
        enqueueSceneSave,
        files,
        isSavingOnLeave: false,
        newName: "Board",
        refs,
        resolveSafeSnapshot: (elements) => ({
          snapshot: elements ?? [],
          prevented: false,
          staleEmptySnapshot: false,
          staleNonRenderableSnapshot: false,
        }),
        setDrawingName: vi.fn(),
        setIsRenaming: vi.fn(),
        setIsSavingOnLeave: vi.fn(),
        setNewName: vi.fn(),
        user: {},
      }),
    );

    await act(() => result.current.handleBackClick());

    expect(toast.error).toHaveBeenCalledWith(
      "Failed to save changes. Please retry before leaving.",
    );
    expect(enqueueSceneSave).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(getSceneElementsIncludingDeleted).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
