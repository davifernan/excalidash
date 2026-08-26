import React from "react";
import * as api from "../../api";
import type { Collection } from "../../types";
import { notify } from "../../notifications";
import { log } from "../../logging";

type UseDashboardCollectionActionsParams = {
  selectedCollectionId: string | null | undefined;
  setSelectedCollectionId: (id: string | null | undefined) => void;
  setCollections: React.Dispatch<React.SetStateAction<Collection[]>>;
  refreshData: () => void;
};

export const useDashboardCollectionActions = ({
  selectedCollectionId,
  setSelectedCollectionId,
  setCollections,
}: UseDashboardCollectionActionsParams) => {
  const handleCreateCollection = async (name: string) => {
    const notificationKey = `collection-create-${name}`;
    notify("loading", "Creating collection...", { key: notificationKey });
    try {
      const created = await api.createCollection(name);
      setCollections((current) => [...current, created]);
      notify("success", `Collection “${name}” created.`, { key: notificationKey });
    } catch (err) {
      log.error("Failed to create collection", { error: err }, { notify: false });
      notify(
        "error",
        `Couldn't create “${name}”. The server did not complete the request. Check your connection and try again.`,
        { key: notificationKey },
      );
      throw err;
    }
  };

  const handleEditCollection = async (id: string, name: string) => {
    let previousName: string | undefined;
    setCollections((current) =>
      current.map((collection) => {
        if (collection.id !== id) return collection;
        previousName ??= collection.name;
        return { ...collection, name };
      }),
    );
    const notificationKey = `collection-rename-${id}`;
    notify("loading", "Renaming collection...", { key: notificationKey });
    try {
      await api.updateCollection(id, name);
      notify("success", `Collection renamed to “${name}”.`, { key: notificationKey });
    } catch (err) {
      log.error("Failed to rename collection", { error: err }, { notify: false });
      if (previousName !== undefined) {
        setCollections((current) =>
          current.map((collection) =>
            collection.id === id ? { ...collection, name: previousName as string } : collection,
          ),
        );
      }
      notify(
        "error",
        "Couldn't rename the collection. The original name was restored. Check your connection and try again.",
        { key: notificationKey },
      );
      throw err;
    }
  };

  const handleDeleteCollection = async (id: string) => {
    let removed: Collection | undefined;
    let removedIndex = -1;
    setCollections((current) => {
      removedIndex = current.findIndex((collection) => collection.id === id);
      removed = current[removedIndex];
      return current.filter((collection) => collection.id !== id);
    });
    const wasSelected = selectedCollectionId === id;
    if (wasSelected) setSelectedCollectionId(undefined);
    const notificationKey = `collection-delete-${id}`;
    notify("loading", "Deleting collection...", { key: notificationKey });
    try {
      await api.deleteCollection(id);
      notify("success", `Collection “${removed?.name ?? ""}” deleted.`, {
        key: notificationKey,
      });
    } catch (err) {
      log.error("Failed to delete collection", { error: err }, { notify: false });
      if (removed) {
        setCollections((current) => {
          if (current.some((collection) => collection.id === id)) return current;
          const next = [...current];
          next.splice(Math.max(0, removedIndex), 0, removed as Collection);
          return next;
        });
      }
      if (wasSelected) setSelectedCollectionId(id);
      notify(
        "error",
        "Couldn't delete the collection. It was restored in the sidebar. Check your connection and try again.",
        { key: notificationKey },
      );
      throw err;
    }
  };
  return {
    handleCreateCollection,
    handleEditCollection,
    handleDeleteCollection,
  };
};
