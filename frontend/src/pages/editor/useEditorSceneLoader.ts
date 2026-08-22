import { useCallback, useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import * as api from "../../api";
import { getPersistedAppState, hasRenderableElements, resolveObjectsSnapMode } from "./shared";
import { computeElementOrderSig } from "./useEditorElementTracking";

type AccessLevel = "none" | "view" | "edit" | "owner";

const SCENE_LOAD_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
export const SCENE_LOAD_MAX_ATTEMPTS = SCENE_LOAD_RETRY_DELAYS_MS.length + 1;

type SceneLoaderParams = {
  id: string | undefined;
  user: unknown;
  location: {
    pathname: string;
    search: string;
    hash: string;
  };
  navigate: NavigateFunction;
  refs: {
    elementVersionMap: MutableRefObject<Map<string, any>>;
    saveQueue: MutableRefObject<Promise<void>>;
    latestElements: MutableRefObject<readonly any[]>;
    initialSceneElements: MutableRefObject<readonly any[]>;
    latestFiles: MutableRefObject<any>;
    lastSyncedFiles: MutableRefObject<Record<string, any>>;
    lastSyncedElementOrderSig: MutableRefObject<string>;
    lastPersistedFiles: MutableRefObject<Record<string, any>>;
    currentDrawingVersion: MutableRefObject<number | null>;
    lastPersistedElements: MutableRefObject<readonly any[]>;
    lastPersistedAppStateSig: MutableRefObject<string | null>;
    suspiciousBlankLoad: MutableRefObject<boolean>;
    hasSceneChangesSinceLoad: MutableRefObject<boolean>;
    excalidrawAPI: MutableRefObject<any>;
    latestAppState: MutableRefObject<any>;
    isBootstrappingScene: MutableRefObject<boolean>;
    hasHydratedInitialScene: MutableRefObject<boolean>;
  };
  setAccessLevel: (accessLevel: AccessLevel) => void;
  setDrawingName: (name: string) => void;
  setInitialData: (data: any) => void;
  setIsReady: (ready: boolean) => void;
  setIsSceneLoading: (loading: boolean) => void;
  setLoadAttempt: (attempt: number) => void;
  setLoadError: (error: string | null) => void;
  recordElementVersion: (element: any) => void;
};

const isRetryableLoadError = (error: unknown): boolean => {
  if (!api.isAxiosError(error)) return false;
  if (!error.response) return true;
  return typeof error.response.status === "number" && error.response.status >= 500;
};

const buildEmptyScene = () => ({
  elements: [],
  appState: {
    viewBackgroundColor: "#ffffff",
    gridSize: null,
    objectsSnapModeEnabled: resolveObjectsSnapMode(null),
    collaborators: new Map(),
  },
  files: {},
  scrollToContent: true,
});

export const useEditorSceneLoader = ({
  id,
  user,
  location,
  navigate,
  refs,
  setAccessLevel,
  setDrawingName,
  setInitialData,
  setIsReady,
  setIsSceneLoading,
  setLoadAttempt,
  setLoadError,
  recordElementVersion,
}: SceneLoaderParams) => {
  const resetRefs = useCallback(() => {
    refs.isBootstrappingScene.current = true;
    refs.hasHydratedInitialScene.current = false;
    refs.elementVersionMap.current.clear();
    refs.saveQueue.current = Promise.resolve();
    refs.latestElements.current = [];
    refs.initialSceneElements.current = [];
    refs.latestFiles.current = {};
    refs.lastSyncedFiles.current = {};
    refs.lastSyncedElementOrderSig.current = "";
    refs.lastPersistedFiles.current = {};
    refs.currentDrawingVersion.current = null;
    refs.lastPersistedElements.current = [];
    refs.lastPersistedAppStateSig.current = null;
    refs.suspiciousBlankLoad.current = false;
    refs.hasSceneChangesSinceLoad.current = false;
    refs.excalidrawAPI.current = null;
  }, [refs]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let finishRetryWait: (() => void) | null = null;

    const waitBeforeRetry = (delay: number) =>
      new Promise<void>((resolve) => {
        finishRetryWait = resolve;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          finishRetryWait = null;
          resolve();
        }, delay);
      });

    resetRefs();
    setIsReady(false);
    setIsSceneLoading(true);
    setLoadAttempt(1);
    setLoadError(null);
    setInitialData(null);

    const loadData = async () => {
      if (!id) {
        setInitialData(buildEmptyScene());
        setIsSceneLoading(false);
        return;
      }
      try {
        const libraryItemsPromise = user
          ? api.getLibrary().catch((err) => {
              console.warn("Failed to load library, using empty:", err);
              return [];
            })
          : Promise.resolve([]);
        let data: Awaited<ReturnType<typeof api.getDrawing>> | null = null;
        for (let attempt = 1; attempt <= SCENE_LOAD_MAX_ATTEMPTS; attempt += 1) {
          setLoadAttempt(attempt);
          try {
            data = await api.getDrawing(id);
            break;
          } catch (error) {
            if (cancelled) return;
            const retryDelay = SCENE_LOAD_RETRY_DELAYS_MS[attempt - 1];
            if (!isRetryableLoadError(error) || retryDelay === undefined) throw error;
            await waitBeforeRetry(retryDelay);
            if (cancelled) return;
          }
        }
        if (cancelled || !data) return;
        const libraryItems = await libraryItemsPromise;
        if (cancelled) return;
        setDrawingName(data.name);
        setAccessLevel(
          data.accessLevel === "view" || data.accessLevel === "edit" || data.accessLevel === "owner"
            ? data.accessLevel
            : "owner",
        );
        const elements = data.elements || [];
        const files = data.files || {};
        const hasPreview = typeof data.preview === "string" && data.preview.trim().length > 0;
        const loadedRenderable = hasRenderableElements(elements);
        refs.suspiciousBlankLoad.current = !loadedRenderable && hasPreview;
        refs.hasSceneChangesSinceLoad.current = false;
        if (import.meta.env.DEV) {
          console.log("[Editor] Loaded drawing", {
            drawingId: id,
            elementCount: elements.length,
            loadedRenderable,
            hasPreview,
            version: data.version ?? null,
            suspiciousBlankLoad: refs.suspiciousBlankLoad.current,
          });
        }
        refs.latestElements.current = elements;
        refs.initialSceneElements.current = elements;
        refs.latestFiles.current = files;
        refs.lastSyncedFiles.current = files;
        refs.lastPersistedFiles.current = files;
        refs.currentDrawingVersion.current = typeof data.version === "number" ? data.version : null;
        refs.lastPersistedElements.current = elements;
        refs.lastSyncedElementOrderSig.current = computeElementOrderSig(elements);
        elements.forEach((element: any) => recordElementVersion(element));
        const persistedAppState = getPersistedAppState(data.appState || {});
        const hydratedAppState = {
          ...persistedAppState,
          objectsSnapModeEnabled: resolveObjectsSnapMode(persistedAppState),
          collaborators: new Map(),
        };
        refs.latestAppState.current = hydratedAppState;
        // Left unset on purpose: what the server stores and what Excalidraw
        // reports are not comparable. Excalidraw fills in its own defaults for
        // anything we never saved -- a board with no grid still reports a grid
        // size -- so the settings are compared with the first state Excalidraw
        // itself reports, once the scene has hydrated.
        refs.lastPersistedAppStateSig.current = null;
        setInitialData({
          elements,
          appState: hydratedAppState,
          files,
          scrollToContent: true,
          libraryItems,
        });
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load drawing", err);
        let message = "Failed to load drawing";
        if (api.isAxiosError(err)) {
          const responseMessage =
            typeof err.response?.data?.message === "string" ? err.response.data.message : null;
          if (err.response && location.pathname.startsWith("/shared/")) {
            message = "This share link is no longer valid. Ask the owner for a new link.";
          } else if (responseMessage) {
            message = responseMessage;
          } else if (err.response?.status === 403) {
            message = "You do not have access to this drawing";
          } else if (err.response?.status === 404) {
            message = "Drawing not found";
          }
          if (err.response?.status === 403 && id && location.pathname.startsWith("/editor/")) {
            navigate(`/shared/${id}${location.search}${location.hash}`, {
              replace: true,
            });
            return;
          }
        }
        toast.error(message);
        refs.latestElements.current = [];
        refs.initialSceneElements.current = [];
        refs.latestFiles.current = {};
        refs.lastSyncedFiles.current = {};
        refs.lastSyncedElementOrderSig.current = "";
        refs.lastPersistedFiles.current = {};
        refs.currentDrawingVersion.current = null;
        refs.lastPersistedElements.current = [];
        refs.lastPersistedAppStateSig.current = null;
        refs.suspiciousBlankLoad.current = false;
        refs.hasSceneChangesSinceLoad.current = false;
        setLoadError(message);
        setInitialData(null);
      } finally {
        if (!cancelled) setIsSceneLoading(false);
      }
    };

    loadData();
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      finishRetryWait?.();
    };
  }, [
    id,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    recordElementVersion,
    refs,
    resetRefs,
    setAccessLevel,
    setDrawingName,
    setInitialData,
    setIsReady,
    setIsSceneLoading,
    setLoadAttempt,
    setLoadError,
    user,
  ]);
};
