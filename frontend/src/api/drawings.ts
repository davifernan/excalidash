import type { Drawing, DrawingSummary } from "../types";
import { normalizePreviewSvg } from "../utils/previewSvg";
import { api } from "./client";

const coerceTimestamp = (value: string | number | Date): number => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
};

type TimestampValue = string | number | Date;

interface HasTimestamps {
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
}

const deserializeTimestamps = <T extends HasTimestamps>(
  data: T,
): T & { createdAt: number; updatedAt: number } => ({
  ...data,
  createdAt: coerceTimestamp(data.createdAt),
  updatedAt: coerceTimestamp(data.updatedAt),
});

const deserializeDrawingSummary = (drawing: unknown): DrawingSummary => {
  if (typeof drawing !== "object" || drawing === null) throw new Error("Invalid drawing data");
  const parsed = drawing as HasTimestamps & DrawingSummary;
  return deserializeTimestamps({
    ...parsed,
    preview:
      typeof parsed.preview === "string" ? normalizePreviewSvg(parsed.preview) : parsed.preview,
  });
};

const deserializeDrawing = (drawing: unknown): Drawing => {
  if (typeof drawing !== "object" || drawing === null) throw new Error("Invalid drawing data");
  const parsed = drawing as HasTimestamps & Drawing;
  return deserializeTimestamps({
    ...parsed,
    preview:
      typeof parsed.preview === "string" ? normalizePreviewSvg(parsed.preview) : parsed.preview,
  });
};

export interface PaginatedDrawings<T> {
  drawings: T[];
  totalCount: number;
  limit?: number;
  offset?: number;
}

export type DrawingSortField = "name" | "createdAt" | "updatedAt";
export type SortDirection = "asc" | "desc";

type DrawingQueryOptions = {
  includeData?: boolean;
  includePreview?: boolean;
  limit?: number;
  offset?: number;
  sortField?: DrawingSortField;
  sortDirection?: SortDirection;
  /** NIL-292: only boards the viewer has starred. */
  favoritesOnly?: boolean;
};

const buildDrawingParams = (
  search?: string,
  collectionId?: string | null,
  options?: DrawingQueryOptions,
): Record<string, string | number> => {
  const params: Record<string, string | number> = {};
  if (search) params.search = search;
  if (collectionId !== undefined)
    params.collectionId = collectionId === null ? "null" : collectionId;
  if (options?.includePreview) params.includePreview = "true";
  if (options?.limit !== undefined) params.limit = options.limit;
  if (options?.offset !== undefined) params.offset = options.offset;
  if (options?.sortField) params.sortField = options.sortField;
  if (options?.sortDirection) params.sortDirection = options.sortDirection;
  if (options?.favoritesOnly) params.favoritesOnly = "true";
  return params;
};

export function getDrawings(
  search?: string,
  collectionId?: string | null,
  options?: Omit<DrawingQueryOptions, "includeData">,
): Promise<PaginatedDrawings<DrawingSummary>>;

export function getDrawings(
  search: string | undefined,
  collectionId: string | null | undefined,
  options: DrawingQueryOptions & { includeData: true },
): Promise<PaginatedDrawings<Drawing>>;

export async function getDrawings(
  search?: string,
  collectionId?: string | null,
  options?: DrawingQueryOptions,
) {
  const params = buildDrawingParams(search, collectionId, options);
  if (options?.includeData) {
    params.includeData = "true";
    const response = await api.get<PaginatedDrawings<Drawing>>("/drawings", { params });
    return { ...response.data, drawings: response.data.drawings.map(deserializeDrawing) };
  }
  const response = await api.get<PaginatedDrawings<DrawingSummary>>("/drawings", { params });
  return { ...response.data, drawings: response.data.drawings.map(deserializeDrawingSummary) };
}

export async function getSharedDrawings(
  search?: string,
  options?: Omit<DrawingQueryOptions, "includeData">,
): Promise<PaginatedDrawings<DrawingSummary>> {
  const params = buildDrawingParams(search, undefined, options);
  const response = await api.get<PaginatedDrawings<DrawingSummary>>("/drawings/shared", { params });
  return { ...response.data, drawings: response.data.drawings.map(deserializeDrawingSummary) };
}

export const getDrawing = async (id: string) => {
  const response = await api.get<Drawing>(`/drawings/${id}`);
  return deserializeDrawing(response.data);
};

export type ShareResolvedUser = { id: string; name: string; email: string };

export const resolveShareUsers = async (
  drawingId: string,
  q: string,
): Promise<ShareResolvedUser[]> => {
  const response = await api.get<{ users: ShareResolvedUser[] }>(
    `/drawings/${drawingId}/share-resolve`,
    { params: { q } },
  );
  return response.data.users;
};

export type DrawingPermissionRow = {
  id: string;
  granteeUserId: string;
  permission: "view" | "comment" | "edit";
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
  granteeUser: ShareResolvedUser;
};

export type DrawingLinkShareRow = {
  id: string;
  permission: "view" | "comment" | "edit";
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
  lastUsedAt: string | null;
};

/** NIL-291: who has a standing claim on this board, direct or via a collection. */
export type DrawingRosterRow = {
  userId: string;
  name: string;
  level: "view" | "comment" | "edit" | "owner";
  via: "drawing" | "collection";
};

export const getDrawingSharing = async (
  drawingId: string,
): Promise<{
  permissions: DrawingPermissionRow[];
  linkShares: DrawingLinkShareRow[];
  roster: DrawingRosterRow[];
}> => {
  const response = await api.get<{
    permissions: DrawingPermissionRow[];
    linkShares: DrawingLinkShareRow[];
    roster: DrawingRosterRow[];
  }>(`/drawings/${drawingId}/sharing`);
  return response.data;
};

export const upsertDrawingPermission = async (
  drawingId: string,
  params: { granteeUserId: string; permission: "view" | "comment" | "edit" },
): Promise<{ permission: DrawingPermissionRow }> => {
  const response = await api.post<{ permission: DrawingPermissionRow }>(
    `/drawings/${drawingId}/permissions`,
    params,
  );
  return response.data;
};

export const revokeDrawingPermission = async (
  drawingId: string,
  permissionId: string,
): Promise<{ success: true }> => {
  const response = await api.delete<{ success: true }>(
    `/drawings/${drawingId}/permissions/${permissionId}`,
  );
  return response.data;
};

export const createLinkShare = async (
  drawingId: string,
  params: {
    permission: "view" | "comment" | "edit";
    expiresAt?: string | null;
    passphrase?: string;
  },
): Promise<{ share: DrawingLinkShareRow; token: string }> => {
  const response = await api.post<{ share: DrawingLinkShareRow; token: string }>(
    `/drawings/${drawingId}/link-shares`,
    params,
  );
  return response.data;
};

export const revokeLinkShare = async (
  drawingId: string,
  shareId: string,
): Promise<{ success: true }> => {
  const response = await api.delete<{ success: true }>(
    `/drawings/${drawingId}/link-shares/${shareId}`,
  );
  return response.data;
};

/**
 * NIL-633: the two guest capabilities NIL-615 enforces server-side --
 * uploading files and seeing comments. `board` is this drawing's own opt-in;
 * `instance` is the admin-set ceiling a board can never raise; `effective` is
 * what a guest actually gets (`combineGuestCapabilities` on the server --
 * this response mirrors it rather than recomputing the AND here).
 */
export type GuestCapabilities = {
  uploadFiles: boolean;
  viewComments: boolean;
};

export type GuestCapabilitySettings = {
  board: GuestCapabilities;
  instance: GuestCapabilities;
  effective: GuestCapabilities;
};

export const getGuestCapabilities = async (drawingId: string): Promise<GuestCapabilitySettings> => {
  const response = await api.get<GuestCapabilitySettings>(
    `/drawings/${drawingId}/guest-capabilities`,
  );
  return response.data;
};

export const updateGuestCapabilities = async (
  drawingId: string,
  updates: Partial<GuestCapabilities>,
): Promise<GuestCapabilitySettings> => {
  const response = await api.put<GuestCapabilitySettings>(
    `/drawings/${drawingId}/guest-capabilities`,
    updates,
  );
  return response.data;
};

export const createDrawing = async (name?: string, collectionId?: string | null) => {
  const response = await api.post<{ id: string }>("/drawings", {
    name: name || "Untitled Drawing",
    collectionId: collectionId ?? null,
    elements: [],
    appState: {},
  });
  return response.data;
};

export const updateDrawing = async (id: string, data: Partial<Drawing>) => {
  const response = await api.put<Drawing>(`/drawings/${id}`, data);
  return deserializeDrawing(response.data);
};

export const deleteDrawing = async (id: string) => {
  const response = await api.delete<{ success: true }>(`/drawings/${id}`);
  return response.data;
};

export const duplicateDrawing = async (id: string) => {
  const response = await api.post<Drawing>(`/drawings/${id}/duplicate`);
  return deserializeDrawing(response.data);
};

/** NIL-365: reversible, controller-only. See archiveRoutes.ts for the rights gate. */
export const archiveDrawing = async (id: string) => {
  const response = await api.post<{ id: string; archivedAt: string | null }>(
    `/drawings/${id}/archive`,
  );
  return response.data;
};

export const restoreDrawing = async (id: string) => {
  const response = await api.post<{ id: string; archivedAt: string | null }>(
    `/drawings/${id}/restore`,
  );
  return response.data;
};

/** NIL-292: star or unstar a board. Requires only view access, like /visit. */
export const setDrawingFavorite = async (id: string, favorite: boolean): Promise<boolean> => {
  const response = favorite
    ? await api.put<{ isFavorite: boolean }>(`/drawings/${id}/favorite`)
    : await api.delete<{ isFavorite: boolean }>(`/drawings/${id}/favorite`);
  return response.data.isFavorite;
};

export type DrawingSnapshotSummary = { id: string; version: number; createdAt: string };

export type DrawingSnapshotFull = DrawingSnapshotSummary & {
  drawingId: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

export const getDrawingHistory = async (
  drawingId: string,
  options?: { limit?: number; offset?: number },
): Promise<{ snapshots: DrawingSnapshotSummary[]; totalCount: number }> => {
  const params: Record<string, number> = {};
  if (options?.limit) params.limit = options.limit;
  if (options?.offset) params.offset = options.offset;
  const response = await api.get(`/drawings/${drawingId}/history`, { params });
  return response.data;
};

export const getDrawingSnapshot = async (
  drawingId: string,
  snapshotId: string,
): Promise<DrawingSnapshotFull> => {
  const response = await api.get(`/drawings/${drawingId}/history/${snapshotId}`);
  return response.data;
};

export const restoreDrawingSnapshot = async (
  drawingId: string,
  snapshotId: string,
): Promise<Drawing> => {
  const response = await api.post(`/drawings/${drawingId}/history/${snapshotId}/restore`);
  return deserializeDrawing(response.data);
};
