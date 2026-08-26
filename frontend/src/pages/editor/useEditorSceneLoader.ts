import { useCallback, useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { MutableRefObject } from "react";
import { notify } from "../../notifications";
import * as api from "../../api";
import { getPersistedAppState, hasRenderableElements, resolveObjectsSnapMode } from "./shared";
import { computeElementOrderSig } from "./useEditorElementTracking";
import { log } from "../../logging";

type AccessLevel = "none" | "view" | "comment" | "edit" | "owner";

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
  setCollectionId: (id: string | null) => void;
  setCollectionName: (name: string | null) => void;
  setInitialData: (data: any) => void;
  setIsReady: (ready: boolean) => void;
  setIsSceneLoading: (loading: boolean) => void;
  setLoadError: (error: string | null) => void;
  recordElementVersion: (element: any) => void;
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
  setCollectionId,
  setCollectionName,
  setInitialData,
  setIsReady,
  setIsSceneLoading,
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
    resetRefs();
    setIsReady(false);
    setIsSceneLoading(true);
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
              log.warn("Failed to load library, using empty", { error: err });
              return [];
            })
          : Promise.resolve([]);
        const [data, libraryItems] = await Promise.all([api.getDrawing(id), libraryItemsPromise]);
        setDrawingName(data.name);
        setCollectionId(data.collectionId ?? null);
        setCollectionName(data.collectionName ?? null);
        setAccessLevel(
          data.accessLevel === "view" ||
            data.accessLevel === "comment" ||
            data.accessLevel === "edit" ||
            data.accessLevel === "owner"
            ? data.accessLevel
            : // An access level this build does not recognise falls back to the
              // least-privileged real one, not the most: an unknown value must
              // never be read as "owner". Before this fix, "comment" itself was
              // such an unrecognised value and fell through to "owner" -- full
              // edit and share UI for someone with comment-only access.
              "view",
        );
        const elements = data.elements || [];
        const files = data.files || {};
        const hasPreview = typeof data.preview === "string" && data.preview.trim().length > 0;
        const loadedRenderable = hasRenderableElements(elements);
        refs.suspiciousBlankLoad.current = !loadedRenderable && hasPreview;
        refs.hasSceneChangesSinceLoad.current = false;
        log.debug("[Editor] Loaded drawing", {
          drawingId: id,
          elementCount: elements.length,
          loadedRenderable,
          hasPreview,
          version: data.version ?? null,
          suspiciousBlankLoad: refs.suspiciousBlankLoad.current,
        });
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
        log.error("Failed to load drawing", { error: err }, { notify: false });
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
        notify("error", message);
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
        setIsSceneLoading(false);
      }
    };

    loadData();
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
    setCollectionId,
    setCollectionName,
    setInitialData,
    setIsReady,
    setIsSceneLoading,
    setLoadError,
    user,
  ]);
};
