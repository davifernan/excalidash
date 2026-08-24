import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  PenTool,
  Check,
  Clock,
  MoreVertical,
  Globe,
  FolderOpen,
  Share2,
  Link2,
  Star,
} from "lucide-react";
import type { DrawingSummary, Collection } from "../types";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { exportDrawingToFile } from "../utils/exportUtils";
import { StorageManageModal } from "./StorageManageModal";
import { CollectionPicker } from "./drawing-card/CollectionPicker";
import { DrawingCardContextMenu } from "./drawing-card/DrawingCardContextMenu";
import { useDrawingPreview } from "./drawing-card/useDrawingPreview";
import { MemberStack } from "./MemberAvatar";
import * as api from "../api";
import { log } from "../logging";

interface DrawingCardProps {
  drawing: DrawingSummary;
  collections: Collection[];
  isSelected: boolean;
  isTrash?: boolean;
  isShared?: boolean;
  isSharedCollection?: boolean;
  onToggleSelection: (e: React.MouseEvent) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMoveToCollection: (id: string, collectionId: string | null) => void;
  onDuplicate: (id: string) => void;
  onClick: (id: string, e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent, id: string) => void;
  onMouseDown?: (e: React.MouseEvent, id: string) => void;
  onPreviewGenerated?: (id: string, preview: string) => void;
  /** Keys of the members on the board right now, or null while that is unknown. */
  onlineKeys?: ReadonlySet<string> | null;
  /** People on the board who are not members of it, counted and never named,
   * or null while that is unknown -- same distinction as `onlineKeys`. */
  guestCount?: number | null;
  /** NIL-292. Omitted entirely (not just handler-less) in trash, where a
   * board is about to stop existing and starring it answers nothing. */
  onToggleFavorite?: (id: string, next: boolean) => void;
}

export const DrawingCard: React.FC<DrawingCardProps> = ({
  drawing,
  collections,
  isSelected,
  isTrash = false,
  isShared = false,
  isSharedCollection = false,
  onToggleSelection,
  onRename,
  onDelete,
  onMoveToCollection,
  onDuplicate,
  onClick,
  onDragStart,
  onMouseDown,
  onPreviewGenerated,
  onlineKeys = null,
  guestCount: guestCountProp = 0,
  onToggleFavorite,
}) => {
  const guestCount = guestCountProp ?? 0;
  const [isRenaming, setIsRenaming] = useState(false);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [showCollectionDropdown, setShowCollectionDropdown] = useState(false);
  const [newName, setNewName] = useState(drawing.name);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(false);
  const [showStorageModal, setShowStorageModal] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const { previewSvg, hasEmbeddedImages, buildExportDrawing } = useDrawingPreview(
    drawing,
    onPreviewGenerated,
  );

  useEffect(() => {
    let cancelled = false;
    if (isShared || isTrash) {
      setStorageAvailable(false);
      return;
    }
    api.isS3Enabled().then((enabled) => {
      if (!cancelled) setStorageAvailable(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, [drawing.id, isShared, isTrash]);

  const handleExport = useCallback(async () => {
    try {
      setIsExporting(true);
      setExportError(null);
      await exportDrawingToFile(await buildExportDrawing());
    } catch (error) {
      log.error("Failed to export drawing", { error }, { notify: false });
      setExportError("Failed to export drawing. Please try again.");
      setTimeout(() => setExportError(null), 3000);
    } finally {
      setIsExporting(false);
    }
  }, [buildExportDrawing]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim()) {
      onRename(drawing.id, newName);
      setIsRenaming(false);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
    setShowMoveSubmenu(false);
  };

  const handleActionsClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 280)),
    });
    setShowMoveSubmenu(false);
  };

  return (
    <>
      <div
        id={`drawing-card-${drawing.id}`}
        onContextMenu={handleContextMenu}
        draggable={!isRenaming && !isShared}
        onDragStart={(e) => {
          if (isRenaming) {
            e.preventDefault();
            return;
          }
          if (isShared) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData("drawingId", drawing.id);
          onDragStart?.(e, drawing.id);
        }}
        onMouseDown={(e) => onMouseDown?.(e, drawing.id)}
        className={clsx(
          "drawing-card group relative flex flex-col bg-white dark:bg-neutral-900 rounded-2xl border-2 transition-all duration-200 ease-out",
          !isTrash &&
            "hover:-translate-y-1 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]",
          isTrash &&
            "shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] opacity-80 grayscale-[0.5]",
          isSelected
            ? "border-neutral-500 dark:border-neutral-500 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]"
            : "border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]",
        )}
      >
        <div
          className="absolute top-2.5 left-2.5 z-20 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity duration-200"
          style={{ opacity: isSelected ? 1 : undefined }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelection(e);
            }}
            data-testid={`select-drawing-${drawing.id}`}
            aria-pressed={isSelected}
            aria-label={`${isSelected ? "Deselect" : "Select"} ${drawing.name}`}
            className={clsx(
              "w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-200 shadow-sm",
              isSelected
                ? "bg-neutral-600 dark:bg-neutral-500 border-neutral-600 dark:border-neutral-500 text-white"
                : "bg-white dark:bg-neutral-800 border-slate-300 dark:border-neutral-600 hover:border-neutral-500 dark:hover:border-neutral-400",
            )}
          >
            {isSelected && <Check size={14} strokeWidth={3} />}
          </button>
        </div>

        <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1.5">
          {onToggleFavorite && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(drawing.id, !drawing.isFavorite);
              }}
              aria-pressed={!!drawing.isFavorite}
              aria-label={drawing.isFavorite ? `Unstar ${drawing.name}` : `Star ${drawing.name}`}
              className={clsx(
                "flex h-9 w-9 items-center justify-center rounded-lg border-2 border-black dark:border-neutral-600 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-opacity",
                drawing.isFavorite
                  ? "bg-amber-400 dark:bg-amber-500 text-white opacity-100"
                  : "bg-white dark:bg-neutral-800 text-slate-700 dark:text-neutral-200 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus:opacity-100",
              )}
            >
              <Star
                size={16}
                aria-hidden="true"
                fill={drawing.isFavorite ? "currentColor" : "none"}
              />
            </button>
          )}
          <button
            ref={actionsButtonRef}
            type="button"
            onClick={handleActionsClick}
            aria-label={`Actions for ${drawing.name}`}
            aria-haspopup="menu"
            aria-expanded={contextMenu !== null}
            className="flex h-9 w-9 items-center justify-center rounded-lg border-2 border-black dark:border-neutral-600 bg-white dark:bg-neutral-800 text-slate-700 dark:text-neutral-200 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus:opacity-100 transition-opacity"
          >
            <MoreVertical size={18} aria-hidden="true" />
          </button>
        </div>

        <button
          type="button"
          aria-label={`Open ${drawing.name}`}
          disabled={isTrash}
          onClick={(e) => !isTrash && onClick(drawing.id, e)}
          className={clsx(
            "aspect-[16/10] bg-slate-50 dark:bg-neutral-800/30 relative overflow-hidden flex items-center justify-center border-b-2 border-black dark:border-neutral-700 rounded-t-xl transition-colors",
            !isTrash &&
              "cursor-pointer group-hover:bg-neutral-100/10 dark:group-hover:bg-neutral-850",
            isTrash && "cursor-default",
            "w-full text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/60 focus-visible:ring-inset disabled:opacity-100",
          )}
        >
          <div className="absolute inset-0 opacity-[0.25] bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] [background-size:24px_24px]"></div>
          {previewSvg ? (
            <div
              className={clsx(
                "w-full h-full p-4 sm:p-5 flex items-center justify-center [&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-w-full [&>svg]:max-h-full [&>svg]:drop-shadow-xs transition-transform duration-550",
                !hasEmbeddedImages &&
                  "dark:[&>svg]:invert dark:[&>svg_rect[fill='white']]:opacity-0 dark:[&>svg_rect[fill='#ffffff']]:opacity-0",
              )}
              dangerouslySetInnerHTML={{ __html: previewSvg }}
            />
          ) : (
            <div className="w-16 h-16 sm:w-20 sm:h-20 lg:w-24 lg:h-24 bg-white dark:bg-neutral-900 rounded-2xl shadow-sm flex items-center justify-center text-neutral-300 dark:text-neutral-400 border border-neutral-100 dark:border-neutral-800 transform group-hover:scale-105 group-hover:rotate-1 transition-all duration-500">
              <PenTool size={32} strokeWidth={1.5} className="sm:w-9 sm:h-9 lg:w-10 lg:h-10" />
            </div>
          )}
          {(drawing.members?.totalCount ?? 0) > 1 || guestCount > 0 ? (
            <div className="absolute bottom-2 left-2 z-20 flex items-center gap-1.5">
              <MemberStack
                members={drawing.members?.items ?? []}
                onlineKeys={onlineKeys}
                size={24}
                max={4}
              />
              {guestCount > 0 && (
                <span
                  title={`${guestCount} ${guestCount === 1 ? "guest" : "guests"} on this board`}
                  className="flex h-6 items-center gap-1 rounded-full border-2 border-dashed border-slate-400 dark:border-neutral-500 bg-white/90 dark:bg-neutral-800/90 px-1.5 text-[10px] font-black text-slate-500 dark:text-neutral-300"
                >
                  <Globe size={10} /> {guestCount}
                </span>
              )}
            </div>
          ) : null}
        </button>

        <div className="p-4 sm:p-5 bg-white dark:bg-neutral-900 rounded-b-2xl relative z-10 flex-1 flex flex-col justify-between">
          <div>
            {isRenaming ? (
              <form
                onSubmit={handleRenameSubmit}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseLeave={() => setIsRenaming(false)}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={() => setIsRenaming(false)}
                  onDragStart={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="w-full px-2 py-1 -ml-2 text-sm sm:text-base font-bold text-slate-900 dark:text-white border-2 border-black dark:border-neutral-600 rounded-lg focus:outline-none shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] bg-white dark:bg-neutral-800"
                />
              </form>
            ) : (
              <h3
                className="text-sm sm:text-base font-bold text-slate-800 dark:text-neutral-100 truncate cursor-text select-none group-hover:text-neutral-900 dark:group-hover:text-white transition-colors"
                title={drawing.name}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const canRename =
                    !isTrash &&
                    (!isShared ||
                      drawing.accessLevel === "edit" ||
                      drawing.accessLevel === "owner");
                  if (canRename) setIsRenaming(true);
                }}
              >
                {drawing.name}
              </h3>
            )}
            {(drawing.accessVia || drawing.linkShared) && (
              <div className="flex items-center gap-1 flex-wrap mt-1.5">
                {drawing.accessVia === "collection" && (
                  <span
                    data-testid="provenance-badge-collection"
                    className="flex items-center gap-1 rounded-full border border-slate-200 dark:border-neutral-700 bg-slate-50 dark:bg-neutral-800 px-1.5 py-0.5 text-[9px] font-bold text-slate-500 dark:text-neutral-400"
                  >
                    <FolderOpen size={9} aria-hidden="true" /> Via collection
                  </span>
                )}
                {drawing.accessVia === "direct" && (
                  <span
                    data-testid="provenance-badge-direct"
                    className="flex items-center gap-1 rounded-full border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-600 dark:text-emerald-400"
                  >
                    <Share2 size={9} aria-hidden="true" /> Shared directly
                  </span>
                )}
                {drawing.linkShared && (
                  <span
                    data-testid="provenance-badge-link"
                    title="This board has an active share link"
                    className="flex items-center gap-1 rounded-full border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
                  >
                    <Link2 size={9} aria-hidden="true" /> Link
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 mt-4 relative">
            <div className="flex flex-col xs:flex-row xs:items-center justify-between gap-2.5">
              <p className="text-[10px] sm:text-[11px] font-medium text-slate-400 dark:text-neutral-500 flex items-center gap-1 sm:gap-1.5 shrink-0 whitespace-nowrap">
                <Clock size={10} className="sm:w-[11px] sm:h-[11px]" />
                {formatDistanceToNow(drawing.updatedAt)} ago
              </p>

              <CollectionPicker
                drawing={drawing}
                collections={collections}
                isShared={isShared}
                isSharedCollection={isSharedCollection}
                isOpen={showCollectionDropdown}
                onToggle={() => setShowCollectionDropdown(!showCollectionDropdown)}
                onClose={() => setShowCollectionDropdown(false)}
                onMoveToCollection={onMoveToCollection}
              />
            </div>
          </div>
        </div>
      </div>

      {contextMenu && (
        <DrawingCardContextMenu
          drawing={drawing}
          collections={collections}
          position={contextMenu}
          isTrash={isTrash}
          isShared={isShared}
          storageAvailable={storageAvailable}
          isExporting={isExporting}
          exportError={exportError}
          showMoveSubmenu={showMoveSubmenu}
          onShowMoveSubmenu={setShowMoveSubmenu}
          onClose={() => {
            setContextMenu(null);
            actionsButtonRef.current?.focus();
          }}
          onRename={() => {
            setIsRenaming(true);
            setContextMenu(null);
          }}
          onMoveToCollection={onMoveToCollection}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onManageStorage={() => {
            setShowStorageModal(true);
            setContextMenu(null);
          }}
          onExport={async (e) => {
            e.stopPropagation();
            await handleExport();
            setContextMenu(null);
          }}
        />
      )}
      <StorageManageModal
        isOpen={showStorageModal}
        drawingId={drawing.id}
        drawingName={drawing.name}
        onClose={() => setShowStorageModal(false)}
      />
    </>
  );
};
