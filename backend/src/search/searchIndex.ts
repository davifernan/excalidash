/**
 * Denormalized search text for `Drawing.searchText` (NIL-363).
 *
 * Recomputed synchronously on every create/update that touches `name` or
 * `elements` -- there is no background reindex job and no separate index
 * table, so a save and its searchability can never drift apart the way a
 * queued indexer would let them. `elements` is the source of truth; this
 * column is a derived, rebuildable cache of it (see `rebuildSearchText`
 * below for how a board recovers if it is ever wrong).
 *
 * Deliberately plain-text `contains` (LIKE) rather than a second SQLite
 * FTS5 virtual table: this product targets one team of about ten people
 * per self-hosted install (`docs/architecture/OWNERSHIP_MODEL.md`), and an
 * FTS5 table would be a second copy of this same text that a raw-SQL path
 * would have to keep in sync by hand, in a codebase whose authz boundary
 * exists specifically because duplicated authorities go stale silently.
 */

const MAX_SEARCH_TEXT_LENGTH = 20_000;

type ExcalidrawTextLikeElement = {
  id?: unknown;
  type?: unknown;
  isDeleted?: unknown;
  text?: unknown;
};

const isTextElement = (value: unknown): value is ExcalidrawTextLikeElement =>
  typeof value === "object" &&
  value !== null &&
  (value as ExcalidrawTextLikeElement).type === "text";

/**
 * Text content of every visible (non-deleted) text element, in element
 * order. Bound text (a label on a rectangle, a sticky note's body) is its
 * own `type: "text"` element with a `containerId` in Excalidraw's own
 * scene format, not a property of the container -- iterating every text
 * element already covers it, no separate walk needed.
 */
export const extractVisibleElementText = (elements: unknown): string[] => {
  if (!Array.isArray(elements)) return [];
  const texts: string[] = [];
  for (const element of elements) {
    if (!isTextElement(element)) continue;
    if (element.isDeleted === true) continue;
    if (typeof element.text !== "string") continue;
    const trimmed = element.text.trim();
    if (trimmed.length > 0) texts.push(trimmed);
  }
  return texts;
};

/** Lowercased, length-capped board name + visible text content. */
export const computeSearchText = (name: string, elements: unknown): string => {
  const parts = [name, ...extractVisibleElementText(elements)];
  const joined = parts.join(" \n ").toLowerCase().trim();
  return joined.length > MAX_SEARCH_TEXT_LENGTH
    ? joined.slice(0, MAX_SEARCH_TEXT_LENGTH)
    : joined;
};

/** Same computation from a board's stored (JSON-string) columns, for the rebuild path. */
export const computeSearchTextFromStored = (params: {
  name: string;
  elementsJson: string;
  parseJsonField: <T>(rawValue: string | null | undefined, fallback: T) => T;
}): string =>
  computeSearchText(params.name, params.parseJsonField<unknown[]>(params.elementsJson, []));

const SNIPPET_RADIUS = 60;

export type ContentMatch = {
  elementId: string | null;
  snippet: string;
};

/**
 * Where a query term actually lives inside a board, for the result page only
 * (never for the `WHERE searchText LIKE` filter itself, which stays a single
 * flat column so it can run in SQL). Re-parses the same `elements` a search
 * hit's row already carries -- cheap at page size (<=50 rows), and it is the
 * only way to hand back a real `elementId` for `viewport.scrollToElement`
 * instead of just "the board matched somewhere".
 *
 * Returns null when the term is only in the board's own name (nothing to
 * scroll to) or matches nothing visible any more -- the degrade case NIL-363
 * names: a hit whose only matching text was since deleted still finds the
 * board (via `searchText`, recomputed on that same save) but has no element
 * to point at, so navigation opens the board at board-level context instead
 * of failing or pointing at a stale element.
 */
export const findContentMatch = (elements: unknown, term: string): ContentMatch | null => {
  const needle = term.trim().toLowerCase();
  if (!needle || !Array.isArray(elements)) return null;
  for (const element of elements) {
    if (!isTextElement(element)) continue;
    if (element.isDeleted === true) continue;
    if (typeof element.text !== "string") continue;
    const haystack = element.text;
    const at = haystack.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(haystack.length, at + needle.length + SNIPPET_RADIUS);
    const elementId = typeof element.id === "string" ? element.id : null;
    return {
      elementId,
      snippet: `${start > 0 ? "…" : ""}${haystack.slice(start, end)}${end < haystack.length ? "…" : ""}`,
    };
  }
  return null;
};
