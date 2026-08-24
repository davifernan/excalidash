import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LayoutGrid, Folder, Plus, Archive, FolderOpen, Shield, Users, Home } from "lucide-react";
import type { Collection } from "../types";
import clsx from "clsx";
import { ConfirmModal } from "./ConfirmModal";
import { ShareCollectionModal } from "./ShareCollectionModal";
import { Logo } from "./Logo";
import { useAuth } from "../context/AuthContext";
import { displayFontFamily } from "../utils/displayFont";
import { SidebarItem } from "./sidebar/SidebarItem";
import { SidebarFooter } from "./sidebar/SidebarFooter";
import { SidebarContextMenu, type SidebarContextMenuState } from "./sidebar/SidebarContextMenu";

interface SidebarProps {
  collections: Collection[];
  selectedCollectionId: string | null | undefined;
  onSelectCollection: (id: string | null | undefined) => void;
  onCreateCollection: (name: string) => void | Promise<void>;
  onEditCollection: (id: string, name: string) => void | Promise<void>;
  onDeleteCollection: (id: string) => void | Promise<void>;
  onDrop?: (e: React.DragEvent, collectionId: string | null) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  collections,
  selectedCollectionId,
  onSelectCollection,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
  onDrop,
}) => {
  const { logout, user, authEnabled } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isCreating, setIsCreating] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const [collectionToDelete, setCollectionToDelete] = useState<string | null>(null);
  const [collectionToShare, setCollectionToShare] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"create" | "rename" | "delete" | null>(null);
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newCollectionName.trim();
    if (name && !pendingAction) {
      setPendingAction("create");
      try {
        await onCreateCollection(name);
        setNewCollectionName("");
        setIsCreating(false);
      } catch {
        // The action reports the actionable error; keep the entered name for retry.
      } finally {
        setPendingAction(null);
      }
    }
  };
  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = editName.trim();
    if (editingId && name && !pendingAction) {
      setPendingAction("rename");
      try {
        await onEditCollection(editingId, name);
        setEditingId(null);
      } catch {
        // Keep the editor and proposed name open for a deliberate retry.
      } finally {
        setPendingAction(null);
      }
    }
  };
  const handleItemContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const collection = collections.find((c) => c.id === id);
    if (collection && !collection.isOwner) return;
    setContextMenu({ x: e.clientX, y: e.clientY, type: "item", id });
  };
  const handleBackgroundContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, type: "background" });
  };
  const visibleCollections = collections.filter((c) => c.name !== "Trash");
  // A collection stops being a folder and starts being a place the moment more
  // than one person can reach it.
  const isTeamCollection = (collection: Collection) =>
    !collection.isOwner || collection.isShared === true;
  const teamCollections = visibleCollections.filter(isTeamCollection);
  const personalCollections = visibleCollections.filter((c) => !isTeamCollection(c));
  const renderCollection = (collection: Collection) => (
    <SidebarItem
      key={collection.id}
      id={collection.id}
      icon={
        selectedCollectionId === collection.id ? <FolderOpen size={18} /> : <Folder size={18} />
      }
      label={collection.name}
      isActive={selectedCollectionId === collection.id}
      onClick={() => onSelectCollection(collection.id)}
      onDoubleClick={() => {
        setEditingId(collection.id);
        setEditName(collection.name);
      }}
      onContextMenu={(e) => handleItemContextMenu(e, collection.id)}
      isEditing={editingId === collection.id}
      editValue={editName}
      onEditChange={setEditName}
      onEditSubmit={handleEditSubmit}
      onEditBlur={() => {
        if (pendingAction !== "rename") setEditingId(null);
      }}
      isEditPending={pendingAction === "rename"}
      onDrop={onDrop}
      extraAction={
        <div className="flex items-center gap-1">
          {/* Shared indicator — only for owned collections that have been shared */}
          {collection.isOwner && collection.isShared && (
            <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
              Shared
            </span>
          )}
          {/* Role badge. Owning something you already shared is
                          implied by the Shared badge; two of them only squeeze
                          the name. */}
          {!(collection.isOwner && collection.isShared) && (
            <span
              className={clsx(
                "text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0",
                !collection.isOwner
                  ? collection.sharedRole === "edit"
                    ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
                    : "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800"
                  : "bg-slate-100 dark:bg-neutral-800 text-slate-400 dark:text-neutral-500 border-slate-200 dark:border-neutral-700",
              )}
            >
              {!collection.isOwner
                ? collection.sharedRole === "edit"
                  ? "Editor"
                  : "Viewer"
                : "Owner"}
            </span>
          )}
        </div>
      }
    />
  );

  return (
    <>
      <div className="w-full flex flex-col h-full bg-transparent">
        <div className="p-4 sm:p-5 pb-2">
          <h1
            className="text-2xl text-slate-900 dark:text-white flex items-center gap-3 tracking-tight"
            style={{ fontFamily: displayFontFamily }}
          >
            <Logo className="w-10 h-10" />
            <span className="mt-1">ExcaliDash</span>
            <span
              className="text-xs font-bold text-red-500 mt-2"
              style={{ fontFamily: "sans-serif" }}
            >
              BETA
            </span>
          </h1>
        </div>
        <nav
          className="flex-1 overflow-y-auto py-3 sm:py-4 space-y-4 sm:space-y-8 custom-scrollbar"
          onContextMenu={handleBackgroundContextMenu}
        >
          <div className="space-y-1">
            <div className="pl-3 pr-2">
              <SidebarItem
                id="team-home"
                icon={<Home size={18} />}
                label="Team Home"
                isActive={location.pathname === "/team"}
                onClick={() => navigate("/team")}
              />
            </div>
          </div>
          <div className="space-y-1">
            <div className="px-6 pb-2 text-[11px] font-bold text-slate-400 dark:text-neutral-500 uppercase tracking-wider">
              Library
            </div>
            <div className="pl-3 pr-2">
              <button
                onClick={() => onSelectCollection(undefined)}
                className={clsx(
                  "w-full flex items-center gap-3 px-3 py-2.5 text-sm font-bold rounded-lg transition-all duration-200 border-2",
                  selectedCollectionId === undefined
                    ? "bg-indigo-50 dark:bg-neutral-800 text-indigo-900 dark:text-neutral-200 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] -translate-y-0.5"
                    : "text-slate-600 dark:text-neutral-400 border-transparent hover:bg-slate-50 dark:hover:bg-neutral-800 hover:border-black dark:hover:border-neutral-700 hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] hover:-translate-y-0.5",
                )}
              >
                <LayoutGrid
                  size={18}
                  className={clsx(
                    selectedCollectionId === undefined
                      ? "text-indigo-900 dark:text-neutral-200"
                      : "text-slate-400 dark:text-neutral-500",
                  )}
                />
                <span className="min-w-0 flex-1 text-left">All Drawings</span>
              </button>
            </div>
            <SidebarItem
              id={"shared"}
              icon={<Shield size={18} />}
              label="Shared with me"
              isActive={selectedCollectionId === "shared"}
              onClick={() => onSelectCollection("shared")}
            />
            <SidebarItem
              id={null}
              icon={<Archive size={18} />}
              label="Unorganized"
              isActive={selectedCollectionId === null}
              onClick={() => onSelectCollection(null)}
              onDrop={onDrop}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between px-6 pb-2 group/header">
              <span className="text-[11px] font-bold text-slate-400 dark:text-neutral-500 uppercase tracking-wider">
                Collections
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsCreating(true);
                }}
                disabled={pendingAction !== null}
                aria-label="New collection"
                className="p-1 text-slate-400 dark:text-neutral-500 hover:text-indigo-600 dark:hover:text-neutral-200 hover:bg-indigo-50 dark:hover:bg-neutral-800 rounded-md transition-all opacity-0 group-hover/header:opacity-100"
                title="New Collection"
              >
                <Plus size={14} strokeWidth={2.5} />
              </button>
            </div>
            {isCreating && (
              <form
                onSubmit={handleCreateSubmit}
                className="mb-2 px-4"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  autoFocus
                  type="text"
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  placeholder="New Collection..."
                  disabled={pendingAction === "create"}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none placeholder:text-slate-400 dark:placeholder:text-neutral-500 font-bold text-slate-900 dark:text-white"
                  onBlur={() => !newCollectionName && setIsCreating(false)}
                />
                {pendingAction === "create" && (
                  <span
                    aria-live="polite"
                    className="mt-2 block text-xs font-bold text-indigo-600 dark:text-indigo-300"
                  >
                    Creating collection...
                  </span>
                )}
              </form>
            )}
            {personalCollections.map(renderCollection)}
            {teamCollections.length > 0 && (
              <div className="pt-3">
                <div className="flex items-center gap-1.5 px-6 pb-2">
                  <Users size={12} className="text-slate-400 dark:text-neutral-500" />
                  <span className="text-[11px] font-bold text-slate-400 dark:text-neutral-500 uppercase tracking-wider">
                    Team
                  </span>
                </div>
                {teamCollections.map(renderCollection)}
              </div>
            )}
          </div>
        </nav>
        <SidebarFooter
          selectedCollectionId={selectedCollectionId}
          authEnabled={authEnabled}
          user={user}
          onDrop={onDrop}
          onLogout={logout}
        />
      </div>
      {contextMenu && (
        <SidebarContextMenu
          contextMenu={contextMenu}
          collections={collections}
          onClose={() => setContextMenu(null)}
          onCreateCollection={() => setIsCreating(true)}
          onRenameCollection={(collection) => {
            setEditingId(collection.id);
            setEditName(collection.name);
          }}
          onShareCollection={setCollectionToShare}
          onDeleteCollection={setCollectionToDelete}
        />
      )}
      <ConfirmModal
        isOpen={!!collectionToDelete}
        title="Delete Collection"
        message="Are you sure you want to delete this collection? All drawings inside will be moved to Unorganized."
        confirmText="Delete Collection"
        pendingText="Deleting collection..."
        isPending={pendingAction === "delete"}
        onConfirm={async () => {
          if (!collectionToDelete || pendingAction) return;
          setPendingAction("delete");
          try {
            await onDeleteCollection(collectionToDelete);
            setCollectionToDelete(null);
          } catch {
            // Keep the confirmation open so the user can retry.
          } finally {
            setPendingAction(null);
          }
        }}
        onCancel={() => setCollectionToDelete(null)}
      />
      <ShareCollectionModal
        isOpen={!!collectionToShare}
        collectionId={collectionToShare ?? ""}
        collectionName={collections.find((c) => c.id === collectionToShare)?.name ?? ""}
        onClose={() => setCollectionToShare(null)}
      />
    </>
  );
};
