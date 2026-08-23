import { useCallback, useEffect } from "react";
import type { MutableRefObject } from "react";
import { buildElements, HISTORY } from "../../integrations/excalidraw/elements";
import { readViewport, unprojectPoint } from "../../integrations/excalidraw/viewport";
import { toast } from "sonner";
import { getDroppedImageFiles, loadDroppedImageData, MULTI_IMAGE_DROP_GAP } from "./droppedImages";
import { addDroppedDocumentWidgets, getDocumentDropFiles } from "./documentDrop";
import {
  boardSettingsSignature,
  hasRenderableElements,
  haveSameElements,
  isStaleNonRenderableSnapshot,
  isSuspiciousEmptySnapshot,
} from "./shared";

type CanvasHandlerRefs = {
  excalidrawAPI: MutableRefObject<any>;
  hasHydratedInitialScene: MutableRefObject<boolean>;
  hasSceneChangesSinceLoad: MutableRefObject<boolean>;
  initialSceneElements: MutableRefObject<readonly any[]>;
  isBootstrappingScene: MutableRefObject<boolean>;
  isSyncing: MutableRefObject<boolean>;
  isHistoryPreviewing: MutableRefObject<boolean>;
  isUnmounting: MutableRefObject<boolean>;
  lastLocalChangeAt: MutableRefObject<number>;
  lastPersistedAppStateSig: MutableRefObject<string | null>;
  latestAppState: MutableRefObject<any>;
  latestElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  debouncedSave: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => void)
    | null
  >;
  suspiciousBlankLoad: MutableRefObject<boolean>;
};

type UseEditorCanvasHandlersParams = {
  canEdit: boolean;
  debouncedSavePreview: (drawingId: string) => void;
  drawingId: string | undefined;
  emitFilesDeltaIfNeeded: (nextFiles: Record<string, any>) => boolean;
  isReady: boolean;
  refs: CanvasHandlerRefs;
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    prevented: boolean;
    staleEmptySnapshot: boolean;
    staleNonRenderableSnapshot: boolean;
  };
  broadcastChanges: (elements: readonly any[], currentFiles?: Record<string, any>) => void;
};

export const useEditorCanvasHandlers = ({
  canEdit,
  debouncedSavePreview,
  drawingId,
  emitFilesDeltaIfNeeded,
  isReady,
  refs,
  resolveSafeSnapshot,
  broadcastChanges,
}: UseEditorCanvasHandlersParams) => {
  const {
    debouncedSave: debouncedSaveRef,
    excalidrawAPI: excalidrawAPIRef,
    hasHydratedInitialScene: hasHydratedInitialSceneRef,
    hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
    initialSceneElements: initialSceneElementsRef,
    isBootstrappingScene: isBootstrappingSceneRef,
    isSyncing: isSyncingRef,
    isHistoryPreviewing: isHistoryPreviewingRef,
    isUnmounting: isUnmountingRef,
    lastLocalChangeAt: lastLocalChangeAtRef,
    lastPersistedAppStateSig: lastPersistedAppStateSigRef,
    latestAppState: latestAppStateRef,
    latestElements: latestElementsRef,
    latestFiles: latestFilesRef,
    suspiciousBlankLoad: suspiciousBlankLoadRef,
  } = refs;

  const handleCanvasChange = useCallback(
    (elements: readonly any[], appState: any, files?: Record<string, any>) => {
      if (!canEdit) return;
      if (isUnmountingRef.current) return;
      if (isSyncingRef.current) return;
      // History preview is a read-only projection over the live canvas. Its
      // updateScene call still fires Excalidraw's onChange callback, so this
      // explicit gate must stay active for the whole preview session.
      if (isHistoryPreviewingRef.current) return;
      latestAppStateRef.current = appState;
      const currentFiles = files || excalidrawAPIRef.current?.getFiles() || {};
      if (Object.keys(currentFiles).length > 0) {
        latestFilesRef.current = currentFiles;
      }
      const allElements = excalidrawAPIRef.current
        ? excalidrawAPIRef.current.getSceneElementsIncludingDeleted()
        : elements;
      if (!hasHydratedInitialSceneRef.current) {
        const matchesInitialSnapshot = haveSameElements(
          allElements,
          initialSceneElementsRef.current,
        );
        const transientHydrationEmpty = isSuspiciousEmptySnapshot(
          initialSceneElementsRef.current,
          allElements,
        );
        const transientHydrationNonRenderable = isStaleNonRenderableSnapshot(
          initialSceneElementsRef.current,
          allElements,
        );
        if (transientHydrationEmpty || transientHydrationNonRenderable) return;
        hasHydratedInitialSceneRef.current = true;
        isBootstrappingSceneRef.current = false;
        // The hydrated scene is the baseline for board settings: this state came
        // from the server, so nothing in it is a change worth saving. Every
        // later difference is somebody's decision.
        lastPersistedAppStateSigRef.current = boardSettingsSignature(appState);
        if (matchesInitialSnapshot) return;
      }
      const { prevented: preventedCanvasOverwrite } = resolveSafeSnapshot(allElements);
      if (preventedCanvasOverwrite) return;
      const hasRenderable = hasRenderableElements(allElements);
      if (hasRenderable && suspiciousBlankLoadRef.current) {
        suspiciousBlankLoadRef.current = false;
      }
      if (isBootstrappingSceneRef.current && !hasRenderable) return;
      latestElementsRef.current = allElements;
      broadcastChanges(allElements, currentFiles);
    },
    [
      broadcastChanges,
      canEdit,
      excalidrawAPIRef,
      hasHydratedInitialSceneRef,
      initialSceneElementsRef,
      isBootstrappingSceneRef,
      isSyncingRef,
      isHistoryPreviewingRef,
      isUnmountingRef,
      lastPersistedAppStateSigRef,
      latestAppStateRef,
      latestElementsRef,
      latestFilesRef,
      resolveSafeSnapshot,
      suspiciousBlankLoadRef,
    ],
  );

  const handleCanvasDropCapture = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      const allDroppedFiles = Array.from(event.dataTransfer?.files || []);
      const documentFiles = getDocumentDropFiles(allDroppedFiles);
      if (documentFiles) {
        event.preventDefault();
        event.stopPropagation();
        if (!canEdit) {
          toast.error("You can view this board, but you cannot add anything to it.");
          return;
        }
        if (!drawingId || !excalidrawAPIRef.current) return;
        const appState = excalidrawAPIRef.current.getAppState?.();
        if (!appState) return;
        const dropPoint = unprojectPoint(
          { x: event.clientX, y: event.clientY },
          readViewport(appState),
        );
        await addDroppedDocumentWidgets({
          canvasApi: excalidrawAPIRef.current,
          drawingId,
          files: documentFiles,
          point: dropPoint,
        });
        return;
      }
      if (!canEdit || !excalidrawAPIRef.current) return;
      const droppedImages = getDroppedImageFiles(event.dataTransfer);
      if (droppedImages.length <= 1 || droppedImages.length !== allDroppedFiles.length) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const appState = excalidrawAPIRef.current.getAppState?.();
      if (!appState) return;
      try {
        const dropPoint = unprojectPoint(
          { x: event.clientX, y: event.clientY },
          readViewport(appState),
        );
        const loadedImages = await Promise.all(droppedImages.map(loadDroppedImageData));
        if (loadedImages.length === 0) return;
        excalidrawAPIRef.current.addFiles(
          loadedImages.map(({ fileId, mimeType, dataURL, created }) => ({
            id: fileId,
            mimeType,
            dataURL,
            created,
          })),
        );
        let nextY = dropPoint.y;
        const imageElements = buildElements(
          loadedImages.map((image, index) => {
            const y = index === 0 ? dropPoint.y - image.height / 2 : nextY;
            nextY = y + image.height + MULTI_IMAGE_DROP_GAP;
            return {
              type: "image" as const,
              x: dropPoint.x - image.width / 2,
              y,
              width: image.width,
              height: image.height,
              fileId: image.fileId as any,
              scale: [1, 1] as [number, number],
              status: "saved" as const,
            };
          }),
        );
        excalidrawAPIRef.current.updateScene({
          elements: [
            ...excalidrawAPIRef.current.getSceneElementsIncludingDeleted(),
            ...imageElements,
          ],
          appState: {
            selectedElementIds: Object.fromEntries(
              imageElements.map((element: any) => [element.id, true]),
            ),
          },
          captureUpdate: HISTORY.immediate,
        });
      } catch (err) {
        console.error("[Editor] Failed to import dropped images", err);
        toast.error("Failed to import dropped images");
      }
    },
    [canEdit, drawingId, excalidrawAPIRef],
  );

  useEffect(() => {
    if (!drawingId || !isReady) return;
    const interval = window.setInterval(() => {
      if (isUnmountingRef.current) return;
      if (isUnmountingRef.current) return;
      if (isSyncingRef.current) return;
      if (!excalidrawAPIRef.current) return;
      const nextFiles = excalidrawAPIRef.current.getFiles?.() || {};
      const didEmit = emitFilesDeltaIfNeeded(nextFiles);
      if (didEmit && latestAppStateRef.current && debouncedSaveRef.current) {
        hasSceneChangesSinceLoadRef.current = true;
        lastLocalChangeAtRef.current = Date.now();
        debouncedSaveRef.current(
          drawingId,
          latestElementsRef.current,
          latestAppStateRef.current,
          nextFiles,
        );
        debouncedSavePreview(drawingId);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [
    debouncedSavePreview,
    debouncedSaveRef,
    drawingId,
    emitFilesDeltaIfNeeded,
    excalidrawAPIRef,
    hasSceneChangesSinceLoadRef,
    isReady,
    isSyncingRef,
    isUnmountingRef,
    lastLocalChangeAtRef,
    latestAppStateRef,
    latestElementsRef,
  ]);

  return { handleCanvasChange, handleCanvasDropCapture };
};
