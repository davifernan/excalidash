import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { renderStoredSceneToSvg } from "../../integrations/excalidraw/export";
import debounce from "lodash/debounce";
import { toast } from "sonner";
import * as api from "../../api";
import { compressExcalidrawFiles } from "../../utils/imageCompression";
import { reconcileElements } from "../../utils/sync";
import {
  CAPTURE_UPDATE_NEVER,
  getFilesDelta,
  heldElementIds,
  getPersistedAppState,
  hasRenderableElements,
} from "./shared";

class DrawingSaveConflictError extends Error {
  constructor(message = "Drawing version conflict") {
    super(message);
    this.name = "DrawingSaveConflictError";
  }
}

type PersistenceRefs = {
  currentDrawingVersion: MutableRefObject<number | null>;
  debouncedSave: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => void)
    | null
  >;
  excalidrawAPI: MutableRefObject<any>;
  isSyncing: MutableRefObject<boolean>;
  isUnmounting: MutableRefObject<boolean>;
  lastLocalChangeAt: MutableRefObject<number>;
  lastPersistedElements: MutableRefObject<readonly any[]>;
  lastPersistedFiles: MutableRefObject<Record<string, any>>;
  lastSyncedFiles: MutableRefObject<Record<string, any>>;
  latestAppState: MutableRefObject<any>;
  latestElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  saveQueue: MutableRefObject<Promise<void>>;
  suspiciousBlankLoad: MutableRefObject<boolean>;
};

type UseEditorPersistenceParams = {
  refs: PersistenceRefs;
  user: unknown;
  normalizeImageElementStatus: (
    elements?: readonly any[],
    files?: Record<string, any> | null,
  ) => readonly any[];
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    snapshot: readonly any[];
    prevented: boolean;
    staleEmptySnapshot: boolean;
    staleNonRenderableSnapshot: boolean;
  };
};

export const useEditorPersistence = ({
  refs,
  user,
  normalizeImageElementStatus,
  resolveSafeSnapshot,
}: UseEditorPersistenceParams) => {
  const saveDataRef = useRef<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => Promise<void>)
    | null
  >(null);
  const savePreviewRef = useRef<
    | ((drawingId: string, elements: readonly any[], appState: any, files: any) => Promise<void>)
    | null
  >(null);
  const saveLibraryRef = useRef<((items: any[]) => Promise<void>) | null>(null);

  saveDataRef.current = async (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files?: Record<string, any>,
  ) => {
    if (!drawingId) return;
    try {
      const persistableAppState = getPersistedAppState(appState);
      const candidateElements = Array.isArray(elements) ? elements : [];
      const {
        snapshot: safeElements,
        prevented,
        staleEmptySnapshot,
        staleNonRenderableSnapshot,
      } = resolveSafeSnapshot(candidateElements);
      const persistableElements = Array.from(safeElements);
      if (refs.suspiciousBlankLoad.current && !hasRenderableElements(persistableElements)) {
        console.warn("[Editor] Blocking non-renderable save due to suspicious blank load", {
          drawingId,
          elementCount: persistableElements.length,
        });
        return;
      }
      if (staleEmptySnapshot || staleNonRenderableSnapshot) {
        console.warn("[Editor] Skipping stale snapshot save", {
          drawingId,
          candidateElementCount: candidateElements.length,
          fallbackElementCount: persistableElements.length,
          prevented,
          staleEmptySnapshot,
          staleNonRenderableSnapshot,
        });
        return;
      }
      let persistableFiles = files ?? refs.latestFiles.current ?? {};
      const editorFilesBeforeCompression = persistableFiles;
      const compressedFilesResult = await compressExcalidrawFiles(persistableFiles);
      if (compressedFilesResult.changed) {
        persistableFiles = compressedFilesResult.files;
        if (
          refs.excalidrawAPI.current &&
          typeof refs.excalidrawAPI.current.addFiles === "function"
        ) {
          refs.isSyncing.current = true;
          try {
            refs.excalidrawAPI.current.addFiles(Object.values(persistableFiles));
          } finally {
            refs.isSyncing.current = false;
          }
        }
        refs.latestFiles.current = persistableFiles;
      }
      const filesChangedSincePersist =
        Object.keys(getFilesDelta(refs.lastPersistedFiles.current || {}, persistableFiles || {}))
          .length > 0;
      const normalizedElementsForSave = Array.from(
        normalizeImageElementStatus(persistableElements, persistableFiles),
      );
      const rebaseOntoLatest = async (
        elementsToSave: readonly any[],
        filesToSave: Record<string, any> | undefined,
      ) => {
        const latest = await api.getDrawing(drawingId);
        const latestVersion = Number(latest?.version);
        if (!Number.isInteger(latestVersion)) {
          throw new DrawingSaveConflictError();
        }

        const mergedElements = reconcileElements(
          elementsToSave,
          Array.isArray(latest?.elements) ? latest.elements : [],
          {
            // The merged scene is applied to the open editor below, so
            // whatever is being typed, dragged or drawn right now must
            // survive it. Without this a rebase mid-gesture pulls the element
            // out of the person's hand.
            protect: heldElementIds(refs.excalidrawAPI.current?.getAppState?.() ?? null),
          },
        );
        const mergedFiles = filesToSave ? { ...(latest?.files || {}), ...filesToSave } : undefined;

        refs.currentDrawingVersion.current = latestVersion;
        refs.excalidrawAPI.current?.updateScene({
          elements: mergedElements,
          captureUpdate: CAPTURE_UPDATE_NEVER,
        });
        refs.latestElements.current = mergedElements;

        return { elements: mergedElements, files: mergedFiles };
      };
      const persistScene = async (
        elementsToSave: readonly any[],
        filesToSave: Record<string, any> | undefined,
        attempt: number,
      ): Promise<void> => {
        const currentVersion = refs.currentDrawingVersion.current;
        if (typeof currentVersion !== "number" || !Number.isInteger(currentVersion)) {
          // A missing version is an unknown base, not permission to overwrite.
          // Load the server scene first and merge the local change onto it so
          // the first write this editor sends is already versioned.
          const rebased = await rebaseOntoLatest(elementsToSave, filesToSave);
          await persistScene(rebased.elements, rebased.files, attempt);
          return;
        }
        try {
          const updated = await api.updateDrawing(drawingId, {
            // Copied because Drawing.elements is mutable and the caller's array
            // is not; the payload must not alias the scene either way.
            elements: [...elementsToSave],
            appState: persistableAppState,
            ...(filesToSave ? { files: filesToSave } : {}),
            version: currentVersion,
          });
          if (typeof updated.version === "number") {
            refs.currentDrawingVersion.current = updated.version;
          }
          refs.lastPersistedElements.current = elementsToSave;
          if (filesToSave) {
            refs.lastPersistedFiles.current = filesToSave;
          }
        } catch (err) {
          if (api.isAxiosError(err) && err.response?.status === 409) {
            // A version is a token for a particular scene. Taking the number
            // out of the conflict response and resending the same elements
            // claims to be based on a scene this editor never saw, and
            // overwrites whatever the other writer just saved. The live socket
            // is not a safety net here: it is a separate channel with its own
            // ordering, and an update can arrive after the payload was built,
            // or not at all after a reconnect.
            //
            // So load the scene behind that version, merge it in with the same
            // rule the live updates use, and save the result.
            if (attempt > 0) throw new DrawingSaveConflictError();

            const rebased = await rebaseOntoLatest(elementsToSave, filesToSave);
            await persistScene(rebased.elements, rebased.files, 1);
            return;
          }
          throw err;
        }
      };
      await persistScene(
        normalizedElementsForSave,
        filesChangedSincePersist ? persistableFiles : undefined,
        0,
      );
      if (compressedFilesResult.changed) {
        // Excalidraw may retain the original blob when addFiles receives an
        // existing content-derived ID, so keep sync comparisons on that map.
        // Book it only after persistence confirms the corresponding save.
        refs.lastSyncedFiles.current = editorFilesBeforeCompression;
      }
    } catch (err) {
      if (err instanceof DrawingSaveConflictError) {
        toast.error("Drawing changed in another tab. Refresh to load latest.");
        throw err;
      }
      console.error("Failed to save drawing", err);
      toast.error("Failed to save changes");
      throw err;
    }
  };

  const enqueueSceneSave = useCallback(
    (
      drawingId: string,
      elements: readonly any[],
      appState: any,
      files?: Record<string, any>,
      options?: { suppressErrors?: boolean },
    ) => {
      const suppressErrors = options?.suppressErrors ?? true;
      refs.saveQueue.current = refs.saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (!saveDataRef.current) return;
          if (suppressErrors) {
            try {
              await saveDataRef.current(drawingId, elements, appState, files);
            } catch {
              // Best-effort autosave errors are surfaced by explicit saves.
            }
            return;
          }
          await saveDataRef.current(drawingId, elements, appState, files);
        });
      return refs.saveQueue.current;
    },
    [refs],
  );

  savePreviewRef.current = async (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files: any,
  ) => {
    if (!drawingId) return;
    try {
      const snapshotFromArgs = Array.isArray(elements) ? elements : [];
      const snapshotFromRef = refs.latestElements.current ?? [];
      const candidateSnapshot =
        hasRenderableElements(snapshotFromArgs) || !hasRenderableElements(snapshotFromRef)
          ? snapshotFromArgs
          : snapshotFromRef;
      const { snapshot: currentSnapshot, prevented: preventedPreviewOverwrite } =
        resolveSafeSnapshot(candidateSnapshot);
      const currentFiles = refs.latestFiles.current ?? files;
      const normalizedSnapshot = normalizeImageElementStatus(currentSnapshot, currentFiles);
      if (refs.suspiciousBlankLoad.current && !hasRenderableElements(currentSnapshot)) {
        return;
      }
      if (preventedPreviewOverwrite) {
        console.warn("[Editor] Prevented stale snapshot preview overwrite", {
          drawingId,
          fallbackElementCount: currentSnapshot.length,
        });
      }
      // Through the layer, so the board's own thumbnail shows its documents
      // rather than empty boxes -- the same substitution the export uses.
      const rendered = await renderStoredSceneToSvg({
        elements: normalizedSnapshot,
        appState: {
          ...appState,
          exportBackground: true,
          viewBackgroundColor: appState.viewBackgroundColor || "#ffffff",
        },
        files: currentFiles,
      });
      if (!rendered.ok) {
        // Reported rather than returned quietly. The capability catches the
        // throw that used to reach the catch below, and nothing in this tree
        // subscribes to the diagnostics sink yet -- so without this line a
        // failed render leaves a stale preview and says nothing to anybody.
        console.error("Failed to save preview", rendered.code, rendered.detail);
        return;
      }
      await api.updateDrawing(drawingId, { preview: rendered.value.outerHTML });
    } catch (err) {
      console.error("Failed to save preview", err);
    }
  };

  saveLibraryRef.current = async (items: any[]) => {
    if (!user) return;
    try {
      await api.updateLibrary(items);
    } catch (err) {
      console.error("Failed to save library", err);
      if (api.isAxiosError(err) && err.response?.status === 401) return;
      toast.error("Failed to save library");
    }
  };

  // Which board the pending save belongs to. Needed when the page is closing
  // and there is no argument left to read it from.
  const pendingDrawingId = useRef<string | null>(null);

  const debouncedSave = useCallback(
    debounce((drawingId, elements, appState, files) => {
      pendingDrawingId.current = drawingId;
      enqueueSceneSave(drawingId, elements, appState, files);
    }, 1000),
    [enqueueSceneSave],
  );
  refs.debouncedSave.current = debouncedSave;

  const debouncedSavePreview = useCallback(
    debounce((drawingId: string) => {
      if (!savePreviewRef.current || !drawingId) return;
      if (refs.isUnmounting.current || refs.isSyncing.current) return;
      const expectedChangeAt = refs.lastLocalChangeAt.current;
      const run = () => {
        if (!savePreviewRef.current) return;
        if (refs.isUnmounting.current || refs.isSyncing.current) return;
        if (refs.lastLocalChangeAt.current !== expectedChangeAt) return;
        const appState = refs.latestAppState.current;
        if (!appState) return;
        void savePreviewRef.current(
          drawingId,
          refs.latestElements.current,
          appState,
          refs.latestFiles.current || {},
        );
      };
      const w = window as any;
      if (typeof w.requestIdleCallback === "function") {
        w.requestIdleCallback(run, { timeout: 2000 });
      } else {
        setTimeout(run, 0);
      }
    }, 30_000),
    [refs],
  );

  const debouncedSaveLibrary = useCallback(
    debounce((items: any[]) => {
      if (saveLibraryRef.current) saveLibraryRef.current(items);
    }, 1000),
    [],
  );

  /**
   * Do not throw away the last second of work.
   *
   * Saving is debounced by a second, and leaving used to cancel whatever was
   * still pending — so a change made just before closing the tab or pressing
   * back was simply gone when the board was opened again. The socket does not
   * help here: it broadcasts, it does not persist.
   *
   * Leaving the editor within the app runs the pending save instead of
   * dropping it. That covers navigating away, which is the common case and the
   * one that can still finish normally.
   */
  useEffect(() => {
    return () => {
      debouncedSave.flush();
      // The preview is cosmetic and regenerates on the next save.
      debouncedSavePreview.cancel();
    };
  }, [debouncedSave, debouncedSavePreview]);

  /**
   * Closing the tab is the harder case: the page is going away and a normal
   * request goes with it. `keepalive` lets the browser finish this one after
   * the page is gone, which is exactly what it is for.
   *
   * `pagehide` rather than `beforeunload`, because `beforeunload` does not fire
   * reliably on mobile, where a tab is often discarded rather than closed.
   */
  useEffect(() => {
    const saveOnTheWayOut = () => {
      const drawingId = pendingDrawingId.current;
      const elements = refs.latestElements.current;
      if (!drawingId || !elements) return;
      if (refs.lastPersistedElements.current === elements) return;
      const version = refs.currentDrawingVersion.current;
      // There is no reliable time for a read/rebase round-trip once the page
      // is disappearing. The interactive save path above establishes the
      // version before queueing changes; never weaken the server contract here.
      if (typeof version !== "number" || !Number.isInteger(version)) return;

      const body = JSON.stringify({
        elements,
        appState: getPersistedAppState(refs.latestAppState.current),
        version,
      });

      try {
        void fetch(`${api.API_URL}/drawings/${drawingId}`, {
          method: "PUT",
          credentials: "include",
          keepalive: true,
          headers: { "Content-Type": "application/json", ...api.currentCsrfHeader() },
          body,
        });
      } catch {
        // Nothing sensible to do while the page is disappearing.
      }
    };

    const onHidden = () => {
      if (document.visibilityState === "hidden") saveOnTheWayOut();
    };
    window.addEventListener("pagehide", saveOnTheWayOut);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", saveOnTheWayOut);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [refs]);

  return {
    debouncedSave,
    debouncedSaveLibrary,
    debouncedSavePreview,
    enqueueSceneSave,
    saveDataRef,
    savePreviewRef,
  };
};
