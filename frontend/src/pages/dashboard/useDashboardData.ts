import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import type { DrawingSortField, SortDirection } from "../../api";
import type { Collection, DrawingSummary } from "../../types";
import { isLatestRequest, mergeUniqueDrawings } from "./pagination";
import { resetDashboardDataStatus, setDashboardDataStatus } from "./dashboardDataStatus";
import { log } from "../../logging";

type SelectedCollectionId = string | null | undefined;

type UseDashboardDataOptions = {
  debouncedSearch: string;
  selectedCollectionId: SelectedCollectionId;
  sortField: DrawingSortField;
  sortDirection: SortDirection;
  pageSize: number;
  onRefreshSuccess?: (drawings: DrawingSummary[]) => void;
  /** NIL-292. A server-side filter on /drawings only -- ignored for the
   * "Shared with me" view, which /drawings/shared does not support yet. */
  favoritesOnly?: boolean;
};

export const useDashboardData = ({
  debouncedSearch,
  selectedCollectionId,
  sortField,
  sortDirection,
  pageSize,
  onRefreshSuccess,
  favoritesOnly = false,
}: UseDashboardDataOptions) => {
  const [drawings, setDrawings] = useState<DrawingSummary[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [drawingsError, setDrawingsError] = useState<string | null>(null);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const listRequestVersionRef = useRef(0);
  const nextOffsetRef = useRef(0);

  const hasMore = drawings.length < totalCount;

  const refreshData = useCallback(async () => {
    const requestVersion = ++listRequestVersionRef.current;
    setIsLoading(true);
    setDrawingsError(null);
    setCollectionsError(null);
    setLoadMoreError(null);
    try {
      const isSharedView = selectedCollectionId === "shared";
      const drawingsPromise = isSharedView
        ? api.getSharedDrawings(debouncedSearch, {
            includePreview: true,
            limit: pageSize,
            offset: 0,
            sortField,
            sortDirection,
          })
        : api.getDrawings(debouncedSearch, selectedCollectionId, {
            includePreview: true,
            limit: pageSize,
            offset: 0,
            sortField,
            sortDirection,
            favoritesOnly,
          });

      const [drawingsResult, collectionsResult] = await Promise.allSettled([
        drawingsPromise,
        api.getCollections(),
      ]);
      if (!isLatestRequest(requestVersion, listRequestVersionRef.current)) return;

      if (drawingsResult.status === "fulfilled") {
        setDrawings(drawingsResult.value.drawings);
        setTotalCount(drawingsResult.value.totalCount);
        nextOffsetRef.current = drawingsResult.value.drawings.length;
        onRefreshSuccess?.(drawingsResult.value.drawings);
      } else {
        log.error("Failed to fetch drawings", { error: drawingsResult.reason }, { notify: false });
        setDrawingsError(
          "We couldn't load drawings. The server may be restarting or your connection may be offline. Check your connection and try again.",
        );
      }

      if (collectionsResult.status === "fulfilled") {
        setCollections(collectionsResult.value);
      } else {
        log.error(
          "Failed to fetch collections",
          { error: collectionsResult.reason },
          { notify: false },
        );
        setCollectionsError(
          "We couldn't load collections. The server may be restarting or your connection may be offline. Check your connection and try again.",
        );
      }
    } catch (err) {
      log.error("Failed to fetch dashboard data", { error: err }, { notify: false });
      setDrawingsError(
        "We couldn't load drawings. The server may be restarting or your connection may be offline. Check your connection and try again.",
      );
      setCollectionsError(
        "We couldn't load collections. The server may be restarting or your connection may be offline. Check your connection and try again.",
      );
    } finally {
      if (isLatestRequest(requestVersion, listRequestVersionRef.current)) {
        setIsLoading(false);
      }
    }
  }, [
    debouncedSearch,
    selectedCollectionId,
    pageSize,
    sortField,
    sortDirection,
    favoritesOnly,
    onRefreshSuccess,
  ]);

  const fetchMore = useCallback(async () => {
    if (isFetchingMore || !hasMore || isLoading) return;
    const requestVersion = listRequestVersionRef.current;
    setIsFetchingMore(true);
    setLoadMoreError(null);
    try {
      const isSharedView = selectedCollectionId === "shared";
      const drawingsRes = await (isSharedView
        ? api.getSharedDrawings(debouncedSearch, {
            includePreview: true,
            limit: pageSize,
            offset: nextOffsetRef.current,
            sortField,
            sortDirection,
          })
        : api.getDrawings(debouncedSearch, selectedCollectionId, {
            includePreview: true,
            limit: pageSize,
            offset: nextOffsetRef.current,
            sortField,
            sortDirection,
            favoritesOnly,
          }));
      if (!isLatestRequest(requestVersion, listRequestVersionRef.current)) return;
      setDrawings((prev) => mergeUniqueDrawings(prev, drawingsRes.drawings));
      setTotalCount(drawingsRes.totalCount);
      nextOffsetRef.current += drawingsRes.drawings.length;
    } catch (err) {
      log.error("Failed to fetch more data", { error: err }, { notify: false });
      if (isLatestRequest(requestVersion, listRequestVersionRef.current)) {
        setLoadMoreError(
          "We couldn't load more drawings. The server may be restarting or your connection may be offline. Try again to continue the list.",
        );
      }
    } finally {
      setIsFetchingMore(false);
    }
  }, [
    isFetchingMore,
    hasMore,
    isLoading,
    debouncedSearch,
    selectedCollectionId,
    pageSize,
    sortField,
    sortDirection,
    favoritesOnly,
  ]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    setDashboardDataStatus({
      drawingsError,
      collectionsError,
      loadMoreError,
      retryDrawings: () => void refreshData(),
      retryCollections: () => void refreshData(),
      retryMore: () => void fetchMore(),
    });
  }, [drawingsError, collectionsError, loadMoreError, refreshData, fetchMore]);

  useEffect(() => resetDashboardDataStatus, []);

  return {
    drawings,
    setDrawings,
    collections,
    setCollections,
    totalCount,
    setTotalCount,
    isFetchingMore,
    isLoading,
    drawingsError,
    collectionsError,
    loadMoreError,
    hasMore,
    refreshData,
    fetchMore,
  };
};
