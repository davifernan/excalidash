import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import type { Collection } from "../../types";
import type { SearchResult } from "../../api";
import { log } from "../../logging";

const FAILURE_MESSAGE =
  "We couldn't load this. The server may be restarting or your connection may be offline. Check your connection and try again.";
const RESULTS_LIMIT = 30;

export type SearchMode = "search" | "archive";

export type SearchPageData = {
  mode: SearchMode;
  setMode: (mode: SearchMode) => void;
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  totalCount: number;
  status: "idle" | "loading" | "error";
  errorMessage: string | null;
  collections: Collection[];
  retry: () => void;
};

/**
 * NIL-298/NIL-362/NIL-365: one page, two modes over the same `GET /search`
 * contract -- "search" (a real term, matched by name or content) and
 * "archive" (browse everything archived, no term required). Both read the
 * exact response the server already filtered by permission; this hook adds
 * no visibility logic of its own.
 */
export const useSearchPageData = (initialMode: SearchMode = "search"): SearchPageData => {
  const [mode, setModeState] = useState<SearchMode>(initialMode);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getCollections()
      .then((result) => {
        if (!cancelled) setCollections(result);
      })
      .catch((error) => log.error("Failed to fetch collections", { error }));
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    const trimmed = query.trim();
    if (mode === "search" && trimmed.length < 2) {
      setResults([]);
      setTotalCount(0);
      setStatus("idle");
      setErrorMessage(null);
      return;
    }
    const requestVersion = ++requestVersionRef.current;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const response = await api.search({
        q: trimmed,
        limit: RESULTS_LIMIT,
        archivedOnly: mode === "archive",
      });
      if (requestVersion !== requestVersionRef.current) return;
      setResults(response.results);
      setTotalCount(response.totalCount);
      setStatus("idle");
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return;
      log.error("Search failed", { error }, { notify: false });
      setStatus("error");
      setErrorMessage(FAILURE_MESSAGE);
    }
  }, [mode, query]);

  useEffect(() => {
    const timer = window.setTimeout(run, mode === "archive" ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [run, mode]);

  const setMode = (next: SearchMode) => {
    setModeState(next);
    setResults([]);
    setTotalCount(0);
  };

  return {
    mode,
    setMode,
    query,
    setQuery,
    results,
    totalCount,
    status,
    errorMessage,
    collections,
    retry: () => void run(),
  };
};
