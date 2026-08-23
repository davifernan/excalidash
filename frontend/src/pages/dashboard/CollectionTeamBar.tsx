import React, { useEffect, useState } from "react";
import { Share2, Users } from "lucide-react";
import * as api from "../../api";
import type { Collection, CollectionMember } from "../../types";
import { MemberStack } from "../../components/MemberAvatar";
import { ShareCollectionModal } from "../../components/ShareCollectionModal";

type CollectionTeamBarProps = {
  collection?: Collection;
  onlineKeys?: ReadonlySet<string> | null;
};

const roleLabel = (collection: Collection): string => {
  if (collection.isOwner) return "You own this collection";
  if (collection.sharedRole === "edit") return "You can edit";
  return "You can view";
};

/**
 * A shared collection looked exactly like a private one once it was open. This
 * says who else is in it, and who it belongs to when that is not you.
 */
export const CollectionTeamBar: React.FC<CollectionTeamBarProps> = ({
  collection,
  onlineKeys = null,
}) => {
  const [members, setMembers] = useState<CollectionMember[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [isSharing, setIsSharing] = useState(false);
  const collectionId = collection?.id;
  const isOwner = collection?.isOwner ?? true;

  useEffect(() => {
    if (!collectionId) {
      setMembers(null);
      return;
    }
    let cancelled = false;
    api
      .getCollectionMembers(collectionId)
      .then((result) => {
        if (cancelled) return;
        setMembers(result.members);
        setTotalCount(result.totalCount);
      })
      .catch(() => {
        // A collection nobody shares is not a failure worth shouting about.
        if (!cancelled) setMembers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  if (!collection || !collectionId) return null;
  // One member is just you: there is no team to describe yet.
  if (!members || members.length < 2) return null;

  const owner = members.find((member) => member.role === "owner");

  return (
    <>
      <div
        data-testid="collection-team-bar"
        className="mb-6 sm:mb-8 -mt-2 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]"
      >
        <MemberStack members={members} onlineKeys={onlineKeys} />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-black text-slate-800 dark:text-neutral-100">
            {totalCount} {totalCount === 1 ? "person" : "people"} in this collection
          </span>
          <span className="text-[11px] font-bold text-slate-400 dark:text-neutral-500">
            {isOwner ? roleLabel(collection) : `Shared by ${owner?.name ?? "someone else"}`}
            {!isOwner && ` · ${roleLabel(collection)}`}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isOwner ? (
            <button
              onClick={() => setIsSharing(true)}
              className="flex items-center gap-2 rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm font-bold text-slate-700 dark:text-neutral-300 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-all hover:-translate-y-0.5 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]"
            >
              <Share2 size={16} /> Share
            </button>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              <Users size={14} /> Team
            </span>
          )}
        </div>
      </div>
      <ShareCollectionModal
        isOpen={isSharing}
        collectionId={collectionId}
        collectionName={collection.name}
        onClose={() => setIsSharing(false)}
      />
    </>
  );
};
