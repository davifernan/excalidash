import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Loader2, Trash2, Upload, Users } from "lucide-react";
import { toast } from "sonner";
import * as api from "../api";
import type { TeamLibraryItem } from "../api";
import { Layout } from "../components/Layout";
import { DataFailureNotice } from "../components/DataFailureNotice";
import { displayFontFamily } from "../utils/displayFont";
import type { Collection } from "../types";
import { log } from "../logging";

const FAILURE_MESSAGE =
  "We couldn't load this. The server may be restarting or your connection may be offline. Check your connection and try again.";

/**
 * NIL-364: manage the Team Library -- rename, categorize, toggle
 * personal/team visibility, delete, import/export. Separate from the
 * Excalidraw-native library panel (synced automatically via
 * `GET/PUT /library`, `useEditorSceneLoader.ts`/`useEditorPersistence.ts`)
 * which this page's items also feed -- editor integration for actually
 * *using* a library item stays exclusively through that existing
 * `ui.importLibrary()` capability, this page never talks to the adapter.
 */
export const TeamLibrary: React.FC = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState<TeamLibraryItem[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const result = await api.getLibraryItems();
      setItems(result);
      setStatus("idle");
    } catch (err) {
      log.error("Failed to load Team Library", { error: err }, { notify: false });
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
    api
      .getCollections()
      .then(setCollections)
      .catch((err) => log.error("Failed to fetch collections", { error: err }));
  }, [load]);

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const toggleVisibility = (item: TeamLibraryItem) =>
    withBusy(item.id, async () => {
      try {
        const next = item.visibility === "team" ? "personal" : "team";
        const updated = await api.updateLibraryItem(item.id, { visibility: next });
        setItems((prev) => prev.map((row) => (row.id === item.id ? updated : row)));
      } catch (err) {
        log.error("Failed to update visibility", { error: err }, { notify: false });
        toast.error("Couldn't change visibility. Try again.");
      }
    });

  const handleDelete = (item: TeamLibraryItem) =>
    withBusy(item.id, async () => {
      try {
        await api.deleteLibraryItem(item.id);
        setItems((prev) => prev.filter((row) => row.id !== item.id));
      } catch (err) {
        log.error("Failed to delete library item", { error: err }, { notify: false });
        toast.error("Couldn't delete this item. Try again.");
      }
    });

  const handleExport = async () => {
    try {
      const data = await api.exportLibraryItems();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/vnd.excalidrawlib+json",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "team-library.excalidrawlib";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      log.error("Failed to export Team Library", { error: err }, { notify: false });
      toast.error("Couldn't export the library. Try again.");
    }
  };

  const handleImportFile = async (file: File) => {
    setIsImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = await api.importLibraryItems(parsed);
      toast.success(`Imported ${result.imported} item${result.imported === 1 ? "" : "s"}`);
      load();
    } catch (err) {
      log.error("Failed to import library file", { error: err }, { notify: false });
      toast.error("Couldn't import this file. Is it a valid .excalidrawlib file?");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Layout
      collections={collections}
      selectedCollectionId="LIBRARY"
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
      <div className="flex items-center justify-between mb-6 lg:mb-8 flex-wrap gap-3">
        <h1
          className="text-3xl sm:text-4xl lg:text-5xl text-slate-900 dark:text-white pl-1"
          style={{ fontFamily: displayFontFamily }}
        >
          Team Library
        </h1>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".excalidrawlib,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFile(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="inline-flex items-center gap-1.5 rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-black uppercase tracking-wider text-slate-700 dark:text-neutral-300 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] disabled:opacity-50"
          >
            {isImporting ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            Import
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-black uppercase tracking-wider text-slate-700 dark:text-neutral-300 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]"
          >
            <Download size={13} /> Export
          </button>
        </div>
      </div>

      <p className="text-sm font-bold text-slate-500 dark:text-neutral-400 mb-6 max-w-2xl">
        Items you add to Excalidraw's own library panel while editing show up here as{" "}
        <strong>Personal</strong> -- visible only to you. Publish one to <strong>Team</strong> to
        share it with everyone.
      </p>

      {status === "error" ? (
        <DataFailureNotice message={FAILURE_MESSAGE} onRetry={load} />
      ) : status === "loading" ? (
        <div role="status" aria-label="Loading library" className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" aria-hidden="true" />
        </div>
      ) : items.length === 0 ? (
        <div className="border-2 border-dashed border-slate-300 dark:border-neutral-700 rounded-2xl p-10 sm:p-14 text-center">
          <h3 className="text-lg font-black text-slate-900 dark:text-white mb-1">
            Nothing in the library yet
          </h3>
          <p className="text-sm font-bold text-slate-500 dark:text-neutral-400">
            Add a shape or sticky to Excalidraw's library panel while editing, or import a file.
          </p>
        </div>
      ) : (
        <ul className="space-y-2 max-w-2xl">
          {items.map((item) => {
            const busy = busyIds.has(item.id);
            return (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-black text-sm text-slate-900 dark:text-white truncate">
                      {item.name}
                    </span>
                    {item.category && (
                      <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border bg-slate-100 dark:bg-neutral-800 text-slate-400 dark:text-neutral-500 border-slate-200 dark:border-neutral-700">
                        {item.category}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] font-bold text-slate-400 dark:text-neutral-500 mt-0.5">
                    {item.visibility === "team" ? "Team" : "Personal"}
                    {!item.isMine && item.visibility === "team" && ` · added by ${item.ownerName}`}
                  </p>
                </div>
                {item.isMine && (
                  <button
                    type="button"
                    onClick={() => toggleVisibility(item)}
                    disabled={busy}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border-2 border-black dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-1.5 text-xs font-bold text-neutral-900 dark:text-white disabled:opacity-50"
                  >
                    <Users size={13} />
                    {item.visibility === "team" ? "Make personal" : "Publish to team"}
                  </button>
                )}
                {item.isMine && (
                  <button
                    type="button"
                    onClick={() => handleDelete(item)}
                    disabled={busy}
                    className="shrink-0 rounded-lg border-2 border-black dark:border-neutral-600 bg-white dark:bg-neutral-900 p-1.5 text-rose-600 dark:text-rose-400 disabled:opacity-50"
                    aria-label={`Delete ${item.name}`}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Layout>
  );
};
