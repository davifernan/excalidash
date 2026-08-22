import { useCallback, useRef, type MutableRefObject } from "react";

type UseEditorAddFilesBridgeInput = {
  drawingId?: string;
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
  const patchedApisRef = useRef<WeakSet<object>>(new WeakSet());
  const emitFilesDeltaIfNeeded = useCallback(
    (nextFiles: Record<string, any>) => {
      latestFilesRef.current = nextFiles;
      return broadcastFiles(nextFiles);
    },
    [broadcastFiles, latestFilesRef],
  );
  const setExcalidrawAPI = useCallback(
    (api: any) => {
      excalidrawAPIRef.current = api;
      if (import.meta.env.DEV) {
        (window as any).__EXCALIDASH_EXCALIDRAW_API__ = api;
      }
      if (api && typeof api.addFiles === "function" && !patchedApisRef.current.has(api as object)) {
        patchedApisRef.current.add(api as object);
        const originalAddFiles = api.addFiles.bind(api);
        api.addFiles = (filesInput: Record<string, any> | any[]) => {
          const normalizedFiles = Array.isArray(filesInput)
            ? filesInput
            : Object.values(filesInput || {});
          originalAddFiles(normalizedFiles);
          if (isSyncingRef.current || isHistoryPreviewingRef.current) return;
          const nextFiles = api.getFiles?.() || {};
          const didEmit = emitFilesDeltaIfNeeded(nextFiles);
          if (didEmit && drawingId && latestAppStateRef.current && debouncedSaveRef.current) {
            hasSceneChangesSinceLoadRef.current = true;
            debouncedSaveRef.current(
              drawingId,
              latestElementsRef.current,
              latestAppStateRef.current,
              latestFilesRef.current || {},
            );
          }
        };
      }
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
