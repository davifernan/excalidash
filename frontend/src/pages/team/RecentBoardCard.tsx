import React from "react";
import { PenTool, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import type { DrawingSummary } from "../../types";
import { MemberStack } from "../../components/MemberAvatar";

type RecentBoardCardProps = {
  drawing: DrawingSummary;
  onlineKeys?: ReadonlySet<string> | null;
  onOpen: (id: string) => void;
};

/**
 * A glance at a board, not a management surface.
 *
 * Deliberately not `DrawingCard`: that component requires rename/delete/
 * move/duplicate handlers to render at all, which is Dashboard's job, not
 * Team Home's. Same visual language (border/shadow/hover, `MemberStack` for
 * presence), reduced to "see it, open it" -- everything else stays on the
 * Dashboard this card links back to.
 */
export const RecentBoardCard: React.FC<RecentBoardCardProps> = ({
  drawing,
  onlineKeys = null,
  onOpen,
}) => (
  <button
    type="button"
    onClick={() => onOpen(drawing.id)}
    aria-label={`Open ${drawing.name}`}
    className={clsx(
      "group flex flex-col text-left bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-all duration-200 ease-out overflow-hidden",
      "hover:-translate-y-1 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]",
      "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/60",
    )}
  >
    <div className="aspect-[16/10] bg-slate-50 dark:bg-neutral-800/30 relative overflow-hidden flex items-center justify-center border-b-2 border-black dark:border-neutral-700">
      <div className="absolute inset-0 opacity-[0.25] bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] [background-size:24px_24px]" />
      {drawing.preview ? (
        <div
          className="w-full h-full p-4 flex items-center justify-center [&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-w-full [&>svg]:max-h-full dark:[&>svg]:invert dark:[&>svg_rect[fill='white']]:opacity-0 dark:[&>svg_rect[fill='#ffffff']]:opacity-0"
          dangerouslySetInnerHTML={{ __html: drawing.preview }}
        />
      ) : (
        <PenTool
          size={28}
          strokeWidth={1.5}
          className="text-neutral-300 dark:text-neutral-600"
          aria-hidden="true"
        />
      )}
    </div>
    <div className="p-3 flex items-center justify-between gap-2 min-w-0">
      <div className="min-w-0">
        <p className="font-bold text-sm text-slate-900 dark:text-white truncate">{drawing.name}</p>
        <p className="flex items-center gap-1 text-[11px] font-bold text-slate-400 dark:text-neutral-500">
          <Clock size={11} aria-hidden="true" />
          {formatDistanceToNow(drawing.updatedAt)} ago
        </p>
      </div>
      {(drawing.members?.totalCount ?? 0) > 1 && (
        <MemberStack
          members={drawing.members?.items ?? []}
          onlineKeys={onlineKeys}
          max={3}
          size={22}
        />
      )}
    </div>
  </button>
);
