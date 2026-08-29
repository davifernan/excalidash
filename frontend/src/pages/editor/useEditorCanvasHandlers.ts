import { useCallback, useEffect } from "react";
import type { MutableRefObject } from "react";
import { buildElements } from "../../integrations/excalidraw/elements";
import { sealSceneDocument } from "../../integrations/excalidraw/adapter";
import type {
  FileCapability,
  SceneCapability,
  ViewportCapability,
} from "../../integrations/excalidraw/capabilities";
import type { FileId } from "../../integrations/excalidraw";
import { notify } from "../../notifications";
import { getDroppedImageFiles, loadDroppedImageData, MULTI_IMAGE_DROP_GAP } from "./droppedImages";
import { addDroppedDocumentWidgets, getDocumentDropFiles } from "./documentDrop";
import {
  boardSettingsSignature,
  hasRenderableElements,
  haveSameElements,
  isStaleNonRenderableSnapshot,
  isSuspiciousEmptySnapshot,
} from "./shared";
import { log } from "../../logging";

const capabilityError = (failure: { seam: string; code: string }) =>
  new Error(`${failure.seam} failed (${failure.code})`);

type CanvasHandlerRefs = {
  excalidrawAPI: MutableRefObject<any>;
  hasHydratedInitialScene: MutableRefObject<boolean>;
  hasSceneChangesSinceLoad: MutableRefObject<boolean>;
  initialSceneElements: MutableRefObject<readonly any[]>;
  isBootstrappingScene: MutableRefObject<boolean>;
  isSyncing: MutableRefObject<boolean>;
  pendingSyncFingerprint: MutableRefObject<Map<string, string> | null>;
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
  canUploadFiles: boolean;
  debouncedSavePreview: (drawingId: string) => void;
  drawingId: string | undefined;
  emitFilesDeltaIfNeeded: (nextFiles: Record<string, any>) => boolean;
  fileCapability: FileCapability;
  isReady: boolean;
  refs: CanvasHandlerRefs;
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    prevented: boolean;
    staleEmptySnapshot: boolean;
    staleNonRenderableSnapshot: boolean;
  };
  scene: SceneCapability;
  viewport: ViewportCapability;
  broadcastChanges: (elements: readonly any[], currentFiles?: Record<string, any>) => void;
};

export const useEditorCanvasHandlers = ({
  canEdit,
  canUploadFiles,
  debouncedSavePreview,
  drawingId,
  emitFilesDeltaIfNeeded,
  fileCapability,
  isReady,
  refs,
  resolveSafeSnapshot,
  scene,
  viewport,
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
    pendingSyncFingerprint: pendingSyncFingerprintRef,
    isHistoryPreviewing: isHistoryPreviewingRef,
    isUnmounting: isUnmountingRef,
    lastLocalChangeAt: lastLocalChangeAtRef,
    lastPersistedAppStateSig: lastPersistedAppStateSigRef,
    latestAppState: latestAppStateRef,
    latestElements: latestElementsRef,
    latestFiles: latestFilesRef,
    suspiciousBlankLoad: suspiciousBlankLoadRef,
  } = refs;
  const readFiles = useCallback(() => {
    const result = fileCapability.read();
    if (!result.ok) throw capabilityError(result);
    return result.value;
  }, [fileCapability]);

  const toScenePoint = useCallback(
    (point: { x: number; y: number }) => {
      const result = viewport.toScene(point);
      if (!result.ok) throw capabilityError(result);
      return result.value;
    },
    [viewport],
  );

  const handleCanvasChange = useCallback(
    (elements: readonly any[], appState: any, files?: Record<string, any>) => {
      if (!canEdit) return;
      if (isUnmountingRef.current) return;
      // NIL-685: `isSyncingRef` closes as soon as the remote-driven scene
      // update this guard is waiting for is actually visible in THIS
      // `onChange` call -- fact, not a frame-count guess. Consume the
      // fingerprint (useEditorCollaboration.ts sets it right after a
      // successful `scene.apply()`) the moment every element it names
      // matches; that consumption is what releases `isSyncingRef` here, not
      // a timer.
      const expectedFingerprint = pendingSyncFingerprintRef.current;
      if (expectedFingerprint) {
        let settled = true;
        for (const el of elements) {
          const id = el?.id;
          if (typeof id !== "string" || !expectedFingerprint.has(id)) continue;
          const actual = `${el?.version ?? 0}:${el?.versionNonce ?? 0}`;
          if (expectedFingerprint.get(id) !== actual) {
            settled = false;
            break;
          }
        }
        if (settled) {
          pendingSyncFingerprintRef.current = null;
          isSyncingRef.current = false;
          return;
        }
      }
      if (isSyncingRef.current) return;
      // History preview is a read-only projection over the live canvas. Its
      // updateScene call still fires Excalidraw's onChange callback, so this
      // explicit gate must stay active for the whole preview session.
      if (isHistoryPreviewingRef.current) return;
      latestAppStateRef.current = appState;
      const currentFiles = files || readFiles();
      if (Object.keys(currentFiles).length > 0) {
        latestFilesRef.current = currentFiles;
      }
      const allElements = elements;
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
      hasHydratedInitialSceneRef,
      initialSceneElementsRef,
      isBootstrappingSceneRef,
      isSyncingRef,
      pendingSyncFingerprintRef,
      isHistoryPreviewingRef,
      isUnmountingRef,
      lastPersistedAppStateSigRef,
      latestAppStateRef,
      latestElementsRef,
      latestFilesRef,
      readFiles,
      resolveSafeSnapshot,
      suspiciousBlankLoadRef,
    ],
  );

  const handleCanvasDropCapture = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      const allDroppedFiles = Array.from(event.dataTransfer?.files || []);
      if (allDroppedFiles.length > 0 && !canUploadFiles) {
        event.preventDefault();
        event.stopPropagation();
        notify(
          "error",
          "Guests cannot upload files to this board. Ask the board owner to enable guest uploads.",
        );
        return;
      }
      const documentFiles = getDocumentDropFiles(allDroppedFiles);
      if (documentFiles) {
        event.preventDefault();
        event.stopPropagation();
        if (!canEdit) {
          notify("error", "You can view this board, but you cannot add anything to it.");
          return;
        }
        if (!drawingId || !excalidrawAPIRef.current) return;
        const dropPoint = toScenePoint({ x: event.clientX, y: event.clientY });
        await addDroppedDocumentWidgets({
          drawingId,
          files: documentFiles,
          point: dropPoint,
          scene,
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
      try {
        const dropPoint = toScenePoint({ x: event.clientX, y: event.clientY });
        const loadedImages = await Promise.all(droppedImages.map(loadDroppedImageData));
        if (loadedImages.length === 0) return;
        const added = fileCapability.add(
          loadedImages.map(({ fileId, mimeType, dataURL, created }) => ({
            id: fileId as FileId,
            mimeType,
            dataURL,
            created,
          })),
        );
        if (!added.ok) throw capabilityError(added);
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
        const applied = scene.apply(
          [
            {
              kind: "replaceDocument",
              document: sealSceneDocument({
                elements: [...latestElementsRef.current, ...imageElements],
                appState: {
                  selectedElementIds: Object.fromEntries(
                    imageElements.map((element: any) => [element.id, true]),
                  ),
                },
                files: {},
              }),
            },
          ],
          { capture: "immediate" },
        );
        if (!applied.ok) throw capabilityError(applied);
      } catch (err) {
        log.error("[Editor] Failed to import dropped images", { error: err }, { notify: false });
        notify("error", "Failed to import dropped images");
      }
    },
    [
      canEdit,
      canUploadFiles,
      drawingId,
      excalidrawAPIRef,
      fileCapability,
      latestElementsRef,
      scene,
      toScenePoint,
    ],
  );

  useEffect(() => {
    if (!drawingId || !isReady) return;
    const interval = window.setInterval(() => {
      if (isUnmountingRef.current) return;
      if (isUnmountingRef.current) return;
      if (isSyncingRef.current) return;
      if (!excalidrawAPIRef.current) return;
      const nextFiles = readFiles();
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
    readFiles,
  ]);

  return { handleCanvasChange, handleCanvasDropCapture };
};
