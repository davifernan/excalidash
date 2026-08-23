import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CornerDownLeft,
  FolderPlus,
  LayoutGrid,
  Loader2,
  PenTool,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import * as api from "../api";
import type { DrawingSummary } from "../types";
import { useDebounce } from "../hooks/useDebounce";
import { DataFailureNotice } from "./DataFailureNotice";

type StaticAction = {
  id: string;
  label: string;
  icon: LucideIcon;
};

const STATIC_ACTIONS: StaticAction[] = [
  { id: "goto-team-home", label: "Go to Team Home", icon: Users },
  { id: "goto-dashboard", label: "Go to Dashboard", icon: LayoutGrid },
  { id: "new-board", label: "New board", icon: PenTool },
  { id: "new-collection", label: "New collection", icon: FolderPlus },
];

type ListItem = { type: "action"; action: StaticAction } | { type: "board"; board: DrawingSummary };

/**
 * Global board switcher / navigation shortcut (NIL-323/NIL-345).
 *
 * Two modes: "list" (search boards, run a static action) and
 * "new-collection" (a one-field name entry the "New collection" action
 * drops into, reusing `api.createCollection` directly rather than the
 * Sidebar's own inline-input UI -- one API call is not worth threading a
 * shared component/context through both places for).
 *
 * Board search calls the same permission-filtered `GET /drawings?search=`
 * endpoint Dashboard and Team Home already use, so results are scoped to
 * what the signed-in user can access without the palette re-deriving that
 * itself.
 */
export const CommandPalette: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen,
  onClose,
}) => {
  const navigate = useNavigate();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const requestIdRef = useRef(0);

  const [mode, setMode] = useState<"list" | "new-collection">("list");
  const [query, setQuery] = useState("");
  const [collectionName, setCollectionName] = useState("");
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [isCreatingBoard, setIsCreatingBoard] = useState(false);
  const [boards, setBoards] = useState<DrawingSummary[]>([]);
  const [boardsStatus, setBoardsStatus] = useState<"idle" | "loading" | "error">("idle");
  const [retryToken, setRetryToken] = useState(0);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const debouncedQuery = useDebounce(query, 200);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setMode("list");
    setQuery("");
    setCollectionName("");
    setBoards([]);
    setBoardsStatus("idle");
    setHighlightedIndex(0);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || mode !== "list") return;
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      setBoards([]);
      setBoardsStatus("idle");
      return;
    }
    const requestId = ++requestIdRef.current;
    setBoardsStatus("loading");
    api
      .getDrawings(trimmed, undefined, { limit: 8 })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setBoards(result.drawings);
        setBoardsStatus("idle");
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        console.error("Command palette board search failed", err);
        setBoards([]);
        setBoardsStatus("error");
      });
  }, [debouncedQuery, isOpen, mode, retryToken]);

  const filteredActions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return STATIC_ACTIONS;
    return STATIC_ACTIONS.filter((action) => action.label.toLowerCase().includes(trimmed));
  }, [query]);

  const items = useMemo<ListItem[]>(
    () => [
      ...filteredActions.map((action): ListItem => ({ type: "action", action })),
      ...boards.map((board): ListItem => ({ type: "board", board })),
    ],
    [filteredActions, boards],
  );

  useEffect(() => {
    setHighlightedIndex(0);
  }, [items.length]);

  if (!isOpen) return null;

  const openBoard = (board: DrawingSummary) => {
    onClose();
    navigate(`/editor/${board.id}`);
  };

  const runAction = async (action: StaticAction) => {
    switch (action.id) {
      case "goto-team-home":
        onClose();
        navigate("/team");
        return;
      case "goto-dashboard":
        onClose();
        navigate("/collections");
        return;
      case "new-board": {
        if (isCreatingBoard) return;
        setIsCreatingBoard(true);
        try {
          const { id } = await api.createDrawing("Untitled Drawing", null);
          onClose();
          navigate(`/editor/${id}`);
        } catch (err) {
          console.error("Failed to create drawing from command palette", err);
          toast.error("Couldn't create a new board. Try again.");
        } finally {
          setIsCreatingBoard(false);
        }
        return;
      }
      case "new-collection":
        setMode("new-collection");
        setCollectionName("");
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
    }
  };

  const handleCreateCollection = async () => {
    const name = collectionName.trim();
    if (!name || isCreatingCollection) return;
    setIsCreatingCollection(true);
    try {
      const created = await api.createCollection(name);
      onClose();
      navigate(`/collections?id=${created.id}`);
    } catch (err) {
      console.error("Failed to create collection from command palette", err);
      toast.error("Couldn't create the collection. Try again.");
    } finally {
      setIsCreatingCollection(false);
    }
  };

  // Screen-reader-only announcement: the visible list already shows this,
  // but nothing else here is an ARIA live region, so a result count or error
  // arriving after a keystroke would otherwise never be spoken.
  const searchStatusMessage =
    mode !== "list"
      ? ""
      : boardsStatus === "loading"
        ? "Searching…"
        : boardsStatus === "error"
          ? "Couldn't search boards."
          : query.trim()
            ? `${boards.length} board${boards.length === 1 ? "" : "s"} found`
            : "";

  const activateHighlighted = () => {
    const item = items[highlightedIndex];
    if (!item) return;
    if (item.type === "action") runAction(item.action);
    else openBoard(item.board);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Options are `tabIndex={-1}` (a virtual cursor via
    // `aria-activedescendant`/arrow keys, not a real tab stop each), so the
    // only real stops left are the input and, when visible, the error
    // retry button or the new-collection back button -- cycle between
    // whichever of those actually exist rather than letting Tab walk out
    // into the blurred page behind the backdrop (same pattern as
    // ConfirmModal.tsx).
    if (event.key === "Tab") {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not([tabindex="-1"]):not(:disabled)',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      if (mode === "new-collection") {
        setMode("list");
        window.setTimeout(() => inputRef.current?.focus(), 0);
      } else {
        onClose();
      }
      return;
    }
    if (mode === "new-collection") {
      if (event.key === "Enter") {
        event.preventDefault();
        handleCreateCollection();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.min(current + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      activateHighlighted();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] p-4">
      <div
        data-testid="command-palette-backdrop"
        className="absolute inset-0 bg-neutral-900/20 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
        className="relative w-full max-w-lg bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.08)] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      >
        <h2 id={titleId} className="sr-only">
          {mode === "new-collection" ? "Name the new collection" : "Search boards and commands"}
        </h2>
        <div aria-live="polite" className="sr-only">
          {searchStatusMessage}
        </div>

        {mode === "new-collection" ? (
          <div className="flex items-center gap-2 border-b-2 border-black dark:border-neutral-700 px-4 py-3">
            <button
              type="button"
              tabIndex={-1}
              onClick={() => {
                setMode("list");
                window.setTimeout(() => inputRef.current?.focus(), 0);
              }}
              aria-label="Back to search (Escape does the same)"
              className="shrink-0 text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
            <input
              ref={inputRef}
              type="text"
              value={collectionName}
              onChange={(event) => setCollectionName(event.target.value)}
              placeholder="Collection name"
              disabled={isCreatingCollection}
              className="flex-1 bg-transparent text-base font-bold text-neutral-900 dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none"
            />
            {isCreatingCollection ? (
              <Loader2 size={16} className="animate-spin text-neutral-400" aria-hidden="true" />
            ) : (
              <span className="hidden sm:flex items-center gap-1 text-[11px] font-bold text-neutral-400 dark:text-neutral-500">
                <CornerDownLeft size={12} aria-hidden="true" /> Create
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 border-b-2 border-black dark:border-neutral-700 px-4 py-3">
            <Search size={18} className="shrink-0 text-neutral-400" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search boards, jump to a page..."
              className="flex-1 bg-transparent text-base font-bold text-neutral-900 dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none"
              aria-autocomplete="list"
              aria-controls={`${titleId}-listbox`}
              aria-activedescendant={
                items[highlightedIndex] ? `${titleId}-item-${highlightedIndex}` : undefined
              }
            />
          </div>
        )}

        {mode === "list" && (
          <div
            id={`${titleId}-listbox`}
            role="listbox"
            aria-label="Boards and commands"
            className="max-h-[50vh] overflow-y-auto py-2"
          >
            {boardsStatus === "error" && (
              <div className="px-3 py-1">
                <DataFailureNotice
                  compact
                  message="Couldn't search boards."
                  onRetry={() => setRetryToken((token) => token + 1)}
                />
              </div>
            )}

            {items.length === 0 && boardsStatus !== "error" && (
              <p className="px-4 py-6 text-center text-sm font-bold text-neutral-400 dark:text-neutral-500">
                {boardsStatus === "loading" ? "Searching..." : "No matches"}
              </p>
            )}

            {filteredActions.length > 0 && (
              <ul>
                {filteredActions.map((action, index) => {
                  const Icon = action.icon;
                  const isHighlighted = index === highlightedIndex;
                  return (
                    <li key={action.id}>
                      <button
                        id={`${titleId}-item-${index}`}
                        role="option"
                        aria-selected={isHighlighted}
                        type="button"
                        tabIndex={-1}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => runAction(action)}
                        disabled={action.id === "new-board" && isCreatingBoard}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm font-bold transition-colors ${
                          isHighlighted
                            ? "bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                            : "text-neutral-700 dark:text-neutral-200"
                        }`}
                      >
                        {action.id === "new-board" && isCreatingBoard ? (
                          <Loader2 size={16} className="animate-spin shrink-0" aria-hidden="true" />
                        ) : (
                          <Icon size={16} className="shrink-0" aria-hidden="true" />
                        )}
                        {action.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {boards.length > 0 && (
              <ul>
                {boards.map((board, boardIndex) => {
                  const index = filteredActions.length + boardIndex;
                  const isHighlighted = index === highlightedIndex;
                  return (
                    <li key={board.id}>
                      <button
                        id={`${titleId}-item-${index}`}
                        role="option"
                        aria-selected={isHighlighted}
                        type="button"
                        tabIndex={-1}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => openBoard(board)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          isHighlighted
                            ? "bg-indigo-50 dark:bg-indigo-500/10"
                            : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                        }`}
                      >
                        <PenTool
                          size={16}
                          className="shrink-0 text-neutral-400 dark:text-neutral-500"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold text-neutral-900 dark:text-white">
                            {board.name}
                          </span>
                          {board.creatorName && (
                            <span className="block truncate text-[11px] font-bold text-neutral-400 dark:text-neutral-500">
                              by {board.creatorName}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
