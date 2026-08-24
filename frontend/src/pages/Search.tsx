import React, { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  FileText,
  Loader2,
  RotateCcw,
  Search as SearchIcon,
} from "lucide-react";
import { toast } from "sonner";
import * as api from "../api";
import { Layout } from "../components/Layout";
import { DataFailureNotice } from "../components/DataFailureNotice";
import { displayFontFamily } from "../utils/displayFont";
import { useSearchPageData } from "./search/useSearchPageData";
import type { SearchResult } from "../api";

const ACCESS_LABEL: Record<string, string> = {
  owner: "Owner",
  edit: "Can edit",
  comment: "Can comment",
  view: "Can view",
};

const ResultRow: React.FC<{
  result: SearchResult;
  isArchiveMode: boolean;
  onOpen: (id: string) => void;
  onRestore: (id: string) => void;
  onArchive: (id: string) => void;
}> = ({ result, isArchiveMode, onOpen, onRestore, onArchive }) => (
  <li>
    <div
      className="group flex items-start gap-3 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] hover:-translate-y-0.5 transition-all cursor-pointer"
      onClick={() => onOpen(result.id)}
      role="button"
      aria-label={`Open ${result.name}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(result.id);
      }}
    >
      <div className="mt-0.5 shrink-0 w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border-2 border-black dark:border-neutral-700 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
        <FileText size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-black text-sm text-slate-900 dark:text-white truncate">
            {result.name}
          </span>
          {result.matchKind === "content" && (
            <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800">
              content match
            </span>
          )}
          {result.accessLevel && (
            <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border bg-slate-100 dark:bg-neutral-800 text-slate-400 dark:text-neutral-500 border-slate-200 dark:border-neutral-700">
              {ACCESS_LABEL[result.accessLevel] ?? result.accessLevel}
            </span>
          )}
        </div>
        {result.snippet && (
          <p className="mt-1 text-xs font-bold text-slate-500 dark:text-neutral-400 line-clamp-2">
            {result.snippet}
          </p>
        )}
        {result.creatorName && (
          <p className="mt-1 text-[11px] font-bold text-slate-400 dark:text-neutral-500">
            by {result.creatorName}
          </p>
        )}
      </div>
      {isArchiveMode ? (
        <button
          type="button"
          aria-label={`Restore ${result.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRestore(result.id);
          }}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border-2 border-black dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-1.5 text-xs font-bold text-neutral-900 dark:text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <RotateCcw size={13} /> Restore
        </button>
      ) : (
        result.accessLevel === "owner" && (
          <button
            type="button"
            aria-label={`Archive ${result.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onArchive(result.id);
            }}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border-2 border-black dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-1.5 text-xs font-bold text-neutral-900 dark:text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            <ArchiveIcon size={13} /> Archive
          </button>
        )
      )}
    </div>
  </li>
);

export const SearchPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    mode,
    setMode,
    query,
    setQuery,
    results,
    totalCount,
    status,
    errorMessage,
    collections,
    retry,
  } = useSearchPageData(searchParams.get("mode") === "archive" ? "archive" : "search");
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());

  const handleOpen = (id: string) => navigate(`/editor/${id}`);

  const handleRestore = async (id: string) => {
    setRestoringIds((prev) => new Set(prev).add(id));
    try {
      await api.restoreDrawing(id);
      toast.success("Board restored");
      retry();
    } catch (err) {
      console.error("Failed to restore drawing:", err);
      toast.error("Couldn't restore this board. Try again.");
    } finally {
      setRestoringIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleArchive = async (id: string) => {
    try {
      await api.archiveDrawing(id);
      toast.success("Board archived");
      retry();
    } catch (err) {
      console.error("Failed to archive drawing:", err);
      toast.error("Couldn't archive this board. Try again.");
    }
  };

  return (
    <Layout
      collections={collections}
      selectedCollectionId="SEARCH"
      onSelectCollection={(id) => {
        if (id === undefined) navigate("/collections");
        else if (id === null) navigate("/collections?id=unorganized");
        else navigate(`/collections?id=${id}`);
      }}
      onCreateCollection={async (name) => {
        await api.createCollection(name);
      }}
      onEditCollection={async (id, name) => {
        await api.updateCollection(id, name);
      }}
      onDeleteCollection={async (id) => {
        await api.deleteCollection(id);
      }}
    >
      <div className="mb-6 lg:mb-8">
        <h1
          className="text-3xl sm:text-4xl lg:text-5xl text-slate-900 dark:text-white pl-1 mb-4"
          style={{ fontFamily: displayFontFamily }}
        >
          {mode === "archive" ? "Archive" : "Search"}
        </h1>

        <div
          className="inline-flex rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 p-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] mb-4"
          role="tablist"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "search"}
            onClick={() => setMode("search")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-black uppercase tracking-wider transition-colors ${
              mode === "search"
                ? "bg-indigo-600 text-white"
                : "text-slate-500 dark:text-neutral-400"
            }`}
          >
            <SearchIcon size={13} /> Search
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "archive"}
            onClick={() => setMode("archive")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-black uppercase tracking-wider transition-colors ${
              mode === "archive"
                ? "bg-indigo-600 text-white"
                : "text-slate-500 dark:text-neutral-400"
            }`}
          >
            <ArchiveRestore size={13} /> Archive
          </button>
        </div>

        {mode === "search" && (
          <div className="relative max-w-xl">
            <SearchIcon
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search boards by name or content"
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border-2 border-black dark:border-neutral-700 bg-slate-50 dark:bg-neutral-800 text-slate-900 dark:text-neutral-100 focus:outline-none focus:border-indigo-600 dark:focus:border-indigo-500 text-sm font-bold shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.05)]"
            />
          </div>
        )}
      </div>

      <div aria-live="polite" className="sr-only">
        {status === "loading"
          ? "Searching…"
          : status === "idle" && (query.trim().length >= 2 || mode === "archive")
            ? `${totalCount} board${totalCount === 1 ? "" : "s"} found`
            : ""}
      </div>

      {errorMessage ? (
        <DataFailureNotice message={errorMessage} onRetry={retry} />
      ) : status === "loading" && results.length === 0 ? (
        <div role="status" aria-label="Searching" className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" aria-hidden="true" />
        </div>
      ) : mode === "search" && query.trim().length < 2 ? (
        <p className="text-sm font-bold text-slate-400 dark:text-neutral-500 py-8">
          Type at least 2 characters to search boards you can see -- your own, shared with you, or
          in a team collection.
        </p>
      ) : results.length === 0 ? (
        <div className="border-2 border-dashed border-slate-300 dark:border-neutral-700 rounded-2xl p-10 sm:p-14 text-center">
          <h3 className="text-lg font-black text-slate-900 dark:text-white mb-1">
            {mode === "archive" ? "Nothing archived" : "No boards found"}
          </h3>
          <p className="text-sm font-bold text-slate-500 dark:text-neutral-400">
            {mode === "archive"
              ? "Boards you archive stay here until restored."
              : "Try a different name, or a word from inside a board."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2 max-w-3xl">
          {results.map((result) => (
            <ResultRow
              key={result.id}
              result={result}
              isArchiveMode={mode === "archive"}
              onOpen={handleOpen}
              onRestore={handleRestore}
              onArchive={handleArchive}
            />
          ))}
        </ul>
      )}
      {restoringIds.size > 0 && (
        <span className="sr-only" role="status">
          Restoring…
        </span>
      )}
    </Layout>
  );
};
