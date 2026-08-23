import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import type { Collection } from "../../types";
import { useDashboardCollectionActions } from "./useDashboardCollectionActions";

vi.mock("../../api", () => ({
  createCollection: vi.fn(),
  getCollections: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const initialCollections: Collection[] = [
  { id: "one", name: "Original", createdAt: 1, isOwner: true },
  { id: "two", name: "Second", createdAt: 2, isOwner: true },
];

const renderActions = (selectedCollectionId: string | null | undefined = "one") => {
  const setSelectedCollectionId = vi.fn();
  const refreshData = vi.fn();
  const rendered = renderHook(() => {
    const [collections, setCollections] = useState(initialCollections);
    const actions = useDashboardCollectionActions({
      selectedCollectionId,
      setSelectedCollectionId,
      setCollections,
      refreshData,
    });
    return { actions, collections };
  });
  return { ...rendered, setSelectedCollectionId, refreshData };
};

describe("dashboard collection actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rolls an optimistic rename back and rejects so the editor stays open", async () => {
    vi.mocked(api.updateCollection).mockRejectedValue(new Error("offline"));
    const { result } = renderActions();

    await act(async () => {
      await expect(result.current.actions.handleEditCollection("one", "Changed")).rejects.toThrow();
    });

    expect(result.current.collections.find((item) => item.id === "one")?.name).toBe("Original");
  });

  it("restores a deleted collection and selection when deletion fails", async () => {
    vi.mocked(api.deleteCollection).mockRejectedValue(new Error("offline"));
    const { result, setSelectedCollectionId } = renderActions();

    await act(async () => {
      await expect(result.current.actions.handleDeleteCollection("one")).rejects.toThrow();
    });

    expect(result.current.collections.map((item) => item.id)).toEqual(["one", "two"]);
    expect(setSelectedCollectionId).toHaveBeenLastCalledWith("one");
  });
});
