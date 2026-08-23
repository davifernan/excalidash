import { useCallback, useEffect, type MutableRefObject } from "react";
import type { FileCapability } from "../../integrations/excalidraw/capabilities";

type UseEditorAddFilesBridgeInput = {
  drawingId?: string;
  /** Files arrive through the boundary; nothing here touches the editor. */
  fileCapability: FileCapability;
  debouncedSaveRef: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => void)
    | null
  >;
  excalidrawAPIRef: MutableRefObject<any>;
  hasSceneChangesSinceLoadRef: MutableRefObject<boolean>;
  isHistoryPreviewingRef: MutableRefObject<boolean>;
  isSyncingRef: MutableRefObject<boolean>;
  latestAppStateRef: MutableRefObject<any>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  latestFilesRef: MutableRefObject<any>;
  setIsReady: (ready: boolean) => void;
  broadcastFiles: (files: Record<string, any>) => boolean;
};

/**
 * Bridges files added through Excalidraw's imperative API back into the same
 * collaboration and persistence path as canvas changes. Keeping the patch here
 * makes its one-time-per-API lifetime explicit and keeps Editor focused on
 * composing the feature hooks.
 */
export const useEditorAddFilesBridge = ({
  drawingId,
  fileCapability,
  debouncedSaveRef,
  excalidrawAPIRef,
  hasSceneChangesSinceLoadRef,
  isHistoryPreviewingRef,
  isSyncingRef,
  latestAppStateRef,
  latestElementsRef,
  latestFilesRef,
  setIsReady,
  broadcastFiles,
}: UseEditorAddFilesBridgeInput) => {
  const emitFilesDeltaIfNeeded = useCallback(
    (nextFiles: Record<string, any>) => {
      latestFilesRef.current = nextFiles;
      return broadcastFiles(nextFiles);
    },
    [broadcastFiles, latestFilesRef],
  );

  /**
   * What to do once the editor has taken new files.
   *
   * This used to be the body of a function written over `api.addFiles`. The
   * interception is still necessary -- Excalidraw calls `addFiles` itself on a
   * paste and the API has no files-changed event -- but it belongs inside the
   * integration layer, not out here on the editor's own object.
   */
  const onFilesArrived = useCallback(() => {
    if (isSyncingRef.current || isHistoryPreviewingRef.current) return;
    const read = fileCapability.read();
    if (!read.ok) return;
    const didEmit = emitFilesDeltaIfNeeded({ ...read.value });
    if (didEmit && drawingId && latestAppStateRef.current && debouncedSaveRef.current) {
      hasSceneChangesSinceLoadRef.current = true;
      debouncedSaveRef.current(
        drawingId,
        latestElementsRef.current,
        latestAppStateRef.current,
        latestFilesRef.current || {},
      );
    }
  }, [
    debouncedSaveRef,
    drawingId,
    emitFilesDeltaIfNeeded,
    fileCapability,
    hasSceneChangesSinceLoadRef,
    isHistoryPreviewingRef,
    isSyncingRef,
    latestAppStateRef,
    latestElementsRef,
    latestFilesRef,
  ]);

  useEffect(() => fileCapability.onFilesAdded(onFilesArrived), [fileCapability, onFilesArrived]);

  const setExcalidrawAPI = useCallback(
    (api: any) => {
      // Still recorded: Editor.tsx builds the one adapter from this ref. What is
      // gone is the patch on the editor's own method and the debug global that
      // handed the raw handle to anything on the page.
      excalidrawAPIRef.current = api;
      setIsReady(true);
    },
    [
      debouncedSaveRef,
      drawingId,
      emitFilesDeltaIfNeeded,
      excalidrawAPIRef,
      hasSceneChangesSinceLoadRef,
      isHistoryPreviewingRef,
      isSyncingRef,
      latestAppStateRef,
      latestElementsRef,
      latestFilesRef,
      setIsReady,
    ],
  );

  return { emitFilesDeltaIfNeeded, setExcalidrawAPI };
};
