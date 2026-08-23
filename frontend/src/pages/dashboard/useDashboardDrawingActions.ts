import React, { useMemo, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import * as api from "../../api";
import type { Collection, DrawingSummary } from "../../types";
import { toast } from "sonner";

type UseDashboardDrawingActionsParams = {
  drawings: DrawingSummary[];
  setDrawings: React.Dispatch<React.SetStateAction<DrawingSummary[]>>;
  collections: Collection[];
  selectedCollectionId: string | null | undefined;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTotalCount: React.Dispatch<React.SetStateAction<number>>;
  uploadFiles: (files: File[], collectionId: string | null) => Promise<void>;
  refreshData: () => void;
  navigate: NavigateFunction;
};

const showTemporaryViewerError = (
  message: string,
  setViewerActionError: React.Dispatch<React.SetStateAction<string | null>>,
) => {
  setViewerActionError(message);
  setTimeout(() => setViewerActionError(null), 6000);
};

const quoteNames = (ids: string[], drawings: DrawingSummary[]): string => {
  const names = ids.map((id) => drawings.find((drawing) => drawing.id === id)?.name || id);
  const visible = names
    .slice(0, 3)
    .map((name) => `“${name}”`)
    .join(", ");
  return names.length > 3 ? `${visible} and ${names.length - 3} more` : visible;
};

const runAll = async (
  ids: string[],
  action: (id: string) => Promise<unknown>,
): Promise<{ succeeded: string[]; failed: string[] }> => {
  const results = await Promise.allSettled(ids.map(action));
  return ids.reduce(
    (summary, id, index) => {
      summary[results[index].status === "fulfilled" ? "succeeded" : "failed"].push(id);
      return summary;
    },
    { succeeded: [] as string[], failed: [] as string[] },
  );
};

export const useDashboardDrawingActions = ({
  drawings,
  setDrawings,
  collections,
  selectedCollectionId,
  selectedIds,
  setSelectedIds,
  setTotalCount,
  uploadFiles,
  refreshData,
  navigate,
}: UseDashboardDrawingActionsParams) => {
  const [drawingToDelete, setDrawingToDelete] = useState<string | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showImportError, setShowImportError] = useState<{
    isOpen: boolean;
    message: string;
  }>({ isOpen: false, message: "" });
  const [viewerActionError, setViewerActionError] = useState<string | null>(null);
  const [potentialDragId, setPotentialDragId] = useState<string | null>(null);
  const [isCreatingDrawing, setIsCreatingDrawing] = useState(false);
  const isCreatingDrawingRef = useRef(false);

  const isTrashView = selectedCollectionId === "trash";
  const isSharedView = selectedCollectionId === "shared";
  const currentCollection = collections.find(
    (collection) => collection.id === selectedCollectionId,
  );
  const isSharedCollection = !!(currentCollection && !currentCollection.isOwner);

  const handleViewerActionError = (message: string) =>
    showTemporaryViewerError(message, setViewerActionError);

  const handleCreateDrawing = async () => {
    if (isCreatingDrawingRef.current) return;
    if (isTrashView || isSharedView) return;
    if (isSharedCollection && currentCollection?.sharedRole !== "edit") {
      handleViewerActionError("Viewers can't create new drawings");
      return;
    }
    isCreatingDrawingRef.current = true;
    setIsCreatingDrawing(true);
    const toastId = "create-drawing";
    toast.loading("Creating drawing...", { id: toastId });
    try {
      const targetCollectionId = selectedCollectionId === undefined ? null : selectedCollectionId;
      const { id } = await api.createDrawing("Untitled Drawing", targetCollectionId);
      toast.success("Drawing created. Opening editor...", { id: toastId });
      navigate(`/editor/${id}`);
    } catch (err) {
      console.error(err);
      const message =
        "Couldn't create a drawing. The server did not complete the request. Check your connection and try again.";
      handleViewerActionError(message);
      toast.error(message, { id: toastId });
    } finally {
      isCreatingDrawingRef.current = false;
      setIsCreatingDrawing(false);
    }
  };

  const handleImportDrawings = async (files: FileList | null) => {
    if (!files || isTrashView || isSharedView) return;
    if (isSharedCollection && currentCollection?.sharedRole !== "edit") {
      handleViewerActionError("Viewers can't import drawings");
      return;
    }
    const targetCollectionId = selectedCollectionId === undefined ? null : selectedCollectionId;
    uploadFiles(Array.from(files), targetCollectionId).finally(refreshData);
  };

  const handleRenameDrawing = async (id: string, name: string) => {
    setDrawings((current) =>
      current.map((drawing) => (drawing.id === id ? { ...drawing, name } : drawing)),
    );
    try {
      await api.updateDrawing(id, { name });
    } catch (err) {
      console.error("Failed to rename drawing:", err);
      refreshData();
      handleViewerActionError(
        `Couldn’t rename ${quoteNames([id], drawings)}. The original name was restored; check your connection and try again.`,
      );
    }
  };

  const moveOutOfCurrentView = (
    update: (drawing: DrawingSummary) => DrawingSummary,
    keep: (drawing: DrawingSummary) => boolean,
  ) => {
    setDrawings((current) => {
      const updated = current.map(update);
      const next = updated.filter(keep);
      setTotalCount((count) => count - (current.length - next.length));
      return next;
    });
  };

  const handleDeleteDrawing = async (id: string) => {
    if (isTrashView) {
      setDrawingToDelete(id);
      return;
    }
    setDrawings((current) => {
      const next = current.filter((drawing) => drawing.id !== id);
      if (next.length !== current.length) setTotalCount((count) => count - 1);
      return next;
    });
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    try {
      await api.updateDrawing(id, { collectionId: "trash" });
    } catch (err) {
      console.error("Failed to move to trash", err);
      refreshData();
      handleViewerActionError(
        `Couldn’t move ${quoteNames([id], drawings)} to Trash. The list was refreshed; check your connection and try again.`,
      );
    }
  };

  const executePermanentDelete = async (id: string) => {
    setDrawingToDelete(null);
    try {
      await api.deleteDrawing(id);
      setDrawings((current) => {
        const next = current.filter((drawing) => drawing.id !== id);
        if (next.length !== current.length) setTotalCount((count) => count - 1);
        return next;
      });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } catch (err) {
      console.error("Failed to delete drawing", err);
      refreshData();
      handleViewerActionError(
        `Couldn’t permanently delete ${quoteNames([id], drawings)}. Nothing was removed; check your connection and try again.`,
      );
    }
  };

  const executeBulkMoveToTrash = async () => {
    const ids = Array.from(selectedIds);
    setDrawings((current) => {
      const next = current.filter((drawing) => !selectedIds.has(drawing.id));
      setTotalCount((count) => count - (current.length - next.length));
      return next;
    });
    setSelectedIds(new Set());
    const { succeeded, failed } = await runAll(ids, (id) =>
      api.updateDrawing(id, { collectionId: "trash" }),
    );
    if (failed.length > 0) {
      refreshData();
      setSelectedIds(new Set(failed));
      handleViewerActionError(
        `Moved ${succeeded.length} of ${ids.length} drawings to Trash. Couldn’t move ${quoteNames(failed, drawings)}. The list was refreshed; retry the selected drawings.`,
      );
    }
  };

  const handleBulkDeleteClick = () => {
    if (selectedIds.size === 0) return;
    if (isTrashView) setShowBulkDeleteConfirm(true);
    else void executeBulkMoveToTrash();
  };

  const executeBulkPermanentDelete = async () => {
    const ids = Array.from(selectedIds);
    setShowBulkDeleteConfirm(false);
    const { succeeded, failed } = await runAll(ids, api.deleteDrawing);
    if (succeeded.length > 0) {
      const toDelete = new Set(succeeded);
      setDrawings((current) => {
        const next = current.filter((drawing) => !toDelete.has(drawing.id));
        setTotalCount((count) => count - (current.length - next.length));
        return next;
      });
    }
    setSelectedIds(new Set(failed));
    if (failed.length > 0) {
      refreshData();
      handleViewerActionError(
        `Deleted ${succeeded.length} of ${ids.length} drawings. Couldn’t delete ${quoteNames(failed, drawings)}. Check your connection and retry the selected drawings.`,
      );
    }
  };

  const handleBulkMove = async (collectionId: string | null) => {
    if (selectedIds.size === 0) return;
    const idsToMove = Array.from(selectedIds);
    moveOutOfCurrentView(
      (drawing) => (selectedIds.has(drawing.id) ? { ...drawing, collectionId } : drawing),
      (drawing) => {
        if (selectedCollectionId === undefined) return true;
        if (selectedCollectionId === null) return drawing.collectionId === null;
        return drawing.collectionId === selectedCollectionId;
      },
    );
    setSelectedIds(new Set());
    const { succeeded, failed } = await runAll(idsToMove, (id) =>
      api.updateDrawing(id, { collectionId }),
    );
    if (failed.length > 0) {
      refreshData();
      setSelectedIds(new Set(failed));
      handleViewerActionError(
        `Moved ${succeeded.length} of ${idsToMove.length} drawings. Couldn’t move ${quoteNames(failed, drawings)}. The list was refreshed; retry the selected drawings.`,
      );
    }
  };

  const handleDuplicateDrawing = async (id: string) => {
    try {
      await api.duplicateDrawing(id);
      refreshData();
    } catch (err) {
      console.error("Failed to duplicate drawing:", err);
      handleViewerActionError(
        `Couldn’t duplicate ${quoteNames([id], drawings)}. Check your connection and try again.`,
      );
    }
  };

  const handleBulkDuplicate = async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const { succeeded, failed } = await runAll(ids, api.duplicateDrawing);
    if (succeeded.length > 0) refreshData();
    setSelectedIds(new Set(failed));
    if (failed.length > 0) {
      handleViewerActionError(
        `Duplicated ${succeeded.length} of ${ids.length} drawings. Couldn’t duplicate ${quoteNames(failed, drawings)}. Check your connection and retry the selected drawings.`,
      );
    }
  };

  const handleMoveToCollection = async (id: string, collectionId: string | null) => {
    moveOutOfCurrentView(
      (drawing) => (drawing.id === id ? { ...drawing, collectionId } : drawing),
      (drawing) => {
        if (selectedCollectionId === undefined) return true;
        if (selectedCollectionId === null) return drawing.collectionId === null;
        return drawing.collectionId === selectedCollectionId;
      },
    );
    try {
      await api.updateDrawing(id, { collectionId });
    } catch (error) {
      console.error("Failed to move drawing:", error);
      refreshData();
      handleViewerActionError(
        `Couldn’t move ${quoteNames([id], drawings)}. The list was refreshed; check your connection and try again.`,
      );
    }
  };

  const handleDrop = async (event: React.DragEvent, targetCollectionId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (isSharedView) return;
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      const files = Array.from(event.dataTransfer.files);
      const libFiles = files.filter((file) => file.name.endsWith(".excalidrawlib"));
      if (libFiles.length > 0) {
        setShowImportError({
          isOpen: true,
          message:
            "Library (.excalidrawlib) imports are not supported in this build. Please import drawings (.excalidraw/.json) instead.",
        });
      }
      const drawingFiles = files.filter((file) => !file.name.endsWith(".excalidrawlib"));
      if (drawingFiles.length > 0) {
        uploadFiles(drawingFiles, targetCollectionId).finally(refreshData);
      }
      return;
    }
    const draggedDrawingId = event.dataTransfer.getData("drawingId");
    if (!draggedDrawingId) return;
    const idsToMove = selectedIds.has(draggedDrawingId)
      ? new Set(selectedIds)
      : new Set([draggedDrawingId]);
    moveOutOfCurrentView(
      (drawing) =>
        idsToMove.has(drawing.id) ? { ...drawing, collectionId: targetCollectionId } : drawing,
      (drawing) => {
        if (selectedCollectionId === undefined) return true;
        if (selectedCollectionId === null) return drawing.collectionId === null;
        return drawing.collectionId === selectedCollectionId;
      },
    );
    if (selectedIds.has(draggedDrawingId)) setSelectedIds(new Set());
    const ids = Array.from(idsToMove);
    const { succeeded, failed } = await runAll(ids, (id) =>
      api.updateDrawing(id, { collectionId: targetCollectionId }),
    );
    if (failed.length > 0) {
      refreshData();
      setSelectedIds(new Set(failed));
      handleViewerActionError(
        `Moved ${succeeded.length} of ${ids.length} drawings. Couldn’t move ${quoteNames(failed, drawings)}. The list was refreshed; retry the selected drawings.`,
      );
    }
  };

  const dragPreviewDrawings = useMemo(() => {
    if (!potentialDragId) return [];
    if (selectedIds.has(potentialDragId) && selectedIds.size > 1) {
      return drawings.filter((drawing) => selectedIds.has(drawing.id));
    }
    const drawing = drawings.find((item) => item.id === potentialDragId);
    return drawing ? [drawing] : [];
  }, [potentialDragId, selectedIds, drawings]);

  const handleCardMouseDown = (_event: React.MouseEvent, id: string) => {
    setPotentialDragId(id);
  };

  const handleCardDragStart = (event: React.DragEvent) => {
    const preview = document.getElementById("drag-preview");
    if (preview) event.dataTransfer.setDragImage(preview, 80, 50);
  };

  const handlePreviewGenerated = (id: string, preview: string) => {
    setDrawings((current) =>
      current.map((drawing) => (drawing.id === id ? { ...drawing, preview } : drawing)),
    );
  };

  return {
    drawingToDelete,
    showBulkDeleteConfirm,
    showImportError,
    viewerActionError,
    isCreatingDrawing,
    isTrashView,
    isSharedView,
    currentCollection,
    isSharedCollection,
    dragPreviewDrawings,
    setDrawingToDelete,
    setShowBulkDeleteConfirm,
    setShowImportError,
    handleViewerActionError,
    handleCreateDrawing,
    handleImportDrawings,
    handleRenameDrawing,
    handleDeleteDrawing,
    executePermanentDelete,
    handleBulkDeleteClick,
    executeBulkPermanentDelete,
    handleBulkMove,
    handleDuplicateDrawing,
    handleBulkDuplicate,
    handleMoveToCollection,
    handleDrop,
    handleCardMouseDown,
    handleCardDragStart,
    handlePreviewGenerated,
  };
};
