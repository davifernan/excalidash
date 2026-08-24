import { api } from "./client";

/**
 * One result from `GET /search` (NIL-362/NIL-298/NIL-363): the merged,
 * permission-aware search over everything an account can see -- own
 * boards, boards reachable through an owned or shared collection, and
 * directly shared boards. See `backend/src/routes/dashboard/searchRoutes.ts`
 * for the query itself; nothing here re-derives or narrows visibility, the
 * server already only ever returns what this account has a claim on.
 */
export interface SearchResult {
  id: string;
  name: string;
  collectionId: string | null;
  archivedAt: string | null;
  updatedAt: number;
  createdAt: number;
  version: number;
  creatorName: string | null;
  accessLevel: "view" | "comment" | "edit" | "owner" | null;
  /** Whether the query matched the board's name or its visible text content. */
  matchKind: "name" | "content";
  /** Set only for a content match -- the element to scroll/highlight to. */
  elementId: string | null;
  /** Set only for a content match -- the text around the hit, for display. */
  snippet: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
  limit: number;
  offset: number;
}

const coerceTimestamp = (value: string | number): number =>
  typeof value === "number" ? value : Date.parse(value);

export const search = async (params: {
  q: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
  archivedOnly?: boolean;
}): Promise<SearchResponse> => {
  const response = await api.get<SearchResponse>("/search", {
    params: {
      q: params.q,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.includeArchived ? { includeArchived: "true" } : {}),
      ...(params.archivedOnly ? { archivedOnly: "true" } : {}),
    },
  });
  return {
    ...response.data,
    results: response.data.results.map((result) => ({
      ...result,
      updatedAt: coerceTimestamp(result.updatedAt),
      createdAt: coerceTimestamp(result.createdAt),
    })),
  };
};
