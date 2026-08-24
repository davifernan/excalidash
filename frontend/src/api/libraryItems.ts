import { api } from "./client";

/**
 * One row from `GET /library/items` (NIL-364) -- the Team Library manager's
 * view of a `LibraryItem`, distinct from the raw Excalidraw panel sync
 * (`getLibrary`/`updateLibrary` in `collections.ts`). Both read the same
 * rows; this one carries the metadata (category, visibility, ownership) the
 * native panel format has no place for.
 */
export interface TeamLibraryItem {
  id: string;
  name: string;
  category: string | null;
  visibility: "personal" | "team";
  ownerUserId: string;
  ownerName: string;
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
}

export const getLibraryItems = async (): Promise<TeamLibraryItem[]> => {
  const response = await api.get<{ items: TeamLibraryItem[] }>("/library/items");
  return response.data.items;
};

export const updateLibraryItem = async (
  id: string,
  changes: Partial<Pick<TeamLibraryItem, "name" | "category" | "visibility">>,
): Promise<TeamLibraryItem> => {
  const response = await api.patch<TeamLibraryItem>(`/library/items/${id}`, changes);
  return response.data;
};

export const deleteLibraryItem = async (id: string): Promise<void> => {
  await api.delete(`/library/items/${id}`);
};

export const exportLibraryItems = async (): Promise<unknown> => {
  const response = await api.get(`/library/export`);
  return response.data;
};

export const importLibraryItems = async (payload: unknown): Promise<{ imported: number }> => {
  const response = await api.post<{ imported: number }>("/library/import", payload);
  return response.data;
};
