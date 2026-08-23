import React, { useEffect, useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorDialogs } from "./EditorDialogs";
import { useEditorCanvasHandlers } from "./useEditorCanvasHandlers";
import { createHistoryCapability } from "../../integrations/excalidraw/history";

vi.mock("../../components/ShareModal", () => ({ ShareModal: () => null }));
vi.mock("../../components/HistoryPanel", () => ({
  HistoryPanel: ({ onPreview }: any) => (
    <button
      onClick={() =>
        onPreview({
          elements: [{ id: "historical", type: "rectangle", version: 1 }],
          appState: {},
          files: {},
        })
      }
    >
      Preview historical version
    </button>
  ),
}));

describe("history preview persistence guard", () => {
  afterEach(() => vi.useRealTimers());

  it("does not broadcast or save a preview even after the save debounce window", async () => {
    vi.useFakeTimers();
    const broadcastChanges = vi.fn();
    const debouncedSave = vi.fn();
    const serverState = {
      version: 12,
      elements: [{ id: "current", type: "rectangle", version: 2 }],
    };
    broadcastChanges.mockImplementation((elements) => {
      serverState.version += 1;
      serverState.elements = [...elements];
    });
    const Harness = () => {
      const initialElements = [{ id: "current", type: "rectangle", version: 2 }];
      const canvasChange = useRef<
        ((elements: readonly any[], appState: any, files?: any) => void) | null
      >(null);
      const isHistoryPreviewing = useRef(false);
      const previewTransaction = useRef<any>(null);
      const currentElements = useRef<readonly any[]>(initialElements);
      const api = useRef<any>({
        getSceneElementsIncludingDeleted: () => currentElements.current,
        getAppState: () => ({}),
        getFiles: () => ({}),
        addFiles: vi.fn(),
        updateScene: ({ elements, appState }: any) => {
          currentElements.current = elements;
          canvasChange.current?.(elements, appState, {});
        },
      });
      const history = {
        beginPreview: (document: any) =>
          createHistoryCapability(() => api.current).beginPreview(document),
      } as any;
      const { handleCanvasChange } = useEditorCanvasHandlers({
        canEdit: true,
        debouncedSavePreview: vi.fn(),
        drawingId: "drawing-1",
        emitFilesDeltaIfNeeded: vi.fn(),
        fileCapability: {
          read: vi.fn(() => ({ ok: true, value: {} })),
        } as any,
        isReady: true,
        refs: {
          excalidrawAPI: api,
          hasHydratedInitialScene: useRef(true),
          hasSceneChangesSinceLoad: useRef(false),
          initialSceneElements: useRef(initialElements),
          isBootstrappingScene: useRef(false),
          isHistoryPreviewing,
          isSyncing: useRef(false),
          isUnmounting: useRef(false),
          lastLocalChangeAt: useRef(0),
          latestAppState: useRef({}),
          latestElements: useRef(initialElements),
          latestFiles: useRef({}),
          debouncedSave: useRef(debouncedSave),
          suspiciousBlankLoad: useRef(false),
        },
        resolveSafeSnapshot: () => ({
          prevented: false,
          staleEmptySnapshot: false,
          staleNonRenderableSnapshot: false,
        }),
        scene: {} as any,
        viewport: {} as any,
        broadcastChanges,
      });
      useEffect(() => {
        canvasChange.current = handleCanvasChange;
      }, [handleCanvasChange]);
      return (
        <EditorDialogs
          drawingId="drawing-1"
          drawingName="Board"
          history={history}
          isHistoryOpen
          isShareOpen={false}
          previewTransactionRef={previewTransaction}
          isHistoryPreviewingRef={isHistoryPreviewing}
          onCloseHistory={vi.fn()}
          onCloseShare={vi.fn()}
        />
      );
    };

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Preview historical version" }));
    await vi.advanceTimersByTimeAsync(1_100);

    expect(broadcastChanges).not.toHaveBeenCalled();
    expect(debouncedSave).not.toHaveBeenCalled();
    expect(serverState.version).toBe(12);
    expect(serverState.elements[0].id).toBe("current");
  });

  it("releases the preview guard and reports when history.beginPreview fails", async () => {
    const isHistoryPreviewing = { current: false };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <EditorDialogs
        drawingId="drawing-1"
        drawingName="Board"
        history={
          {
            beginPreview: vi.fn().mockResolvedValue({
              ok: false,
              code: "editor-changed",
              seam: "history.beginPreview",
            }),
          } as any
        }
        isHistoryOpen
        isShareOpen={false}
        previewTransactionRef={{ current: null }}
        isHistoryPreviewingRef={isHistoryPreviewing}
        onCloseHistory={vi.fn()}
        onCloseShare={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview historical version" }));
    await Promise.resolve();

    expect(isHistoryPreviewing.current).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "[Editor] Failed to begin history preview",
      expect.objectContaining({ ok: false, seam: "history.beginPreview" }),
    );
    error.mockRestore();
  });
});
