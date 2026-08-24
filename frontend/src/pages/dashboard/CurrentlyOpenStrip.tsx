import React from "react";
import { Radio } from "lucide-react";
import clsx from "clsx";
import type { DrawingSummary } from "../../types";
import { MemberStack } from "../../components/MemberAvatar";
import {
  guestCountFor,
  presenceKeysFor,
  type PresenceByDrawing,
} from "./useDashboardPresence";

type CurrentlyOpenStripProps = {
  drawings: readonly DrawingSummary[];
  presence: PresenceByDrawing | null;
  onOpenDrawing: (id: string) => void;
};

/**
 * "Someone's on this board right now" -- for the boards already on screen.
 *
 * Built on the same presence the grid already fetched, not a second query:
 * `useDashboardPresence`'s null-vs-empty-set distinction is the whole
 * contract here. A board past `MAX_WATCHED`, or one presence just hasn't
 * answered for yet, must not appear -- but "not appearing" cannot be read as
 * "confirmed empty" either, so this renders nothing extra for it rather than
 * a placeholder. Only a board *confirmed* to have someone on it earns a
 * place in the strip (NIL-293).
 */
export const CurrentlyOpenStrip: React.FC<CurrentlyOpenStripProps> = ({
  drawings,
  presence,
  onOpenDrawing,
}) => {
  const open = drawings.filter((drawing) => {
    const keys = presenceKeysFor(presence, drawing.id);
    const guests = guestCountFor(presence, drawing.id);
    return (keys && keys.size > 0) || (guests ?? 0) > 0;
  });

  if (open.length === 0) return null;

  return (
    <div className="mb-6 sm:mb-8 -mt-2">
      <div className="flex items-center gap-1.5 mb-2 px-1">
        <Radio size={12} className="text-emerald-500" aria-hidden="true" />
        <span className="text-[11px] font-black uppercase tracking-wider text-slate-400 dark:text-neutral-500">
          Open right now
        </span>
      </div>
      <div
        data-testid="currently-open-strip"
        className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1 snap-x snap-mandatory sm:snap-none custom-scrollbar"
      >
        {open.map((drawing) => {
          const onlineKeys = presenceKeysFor(presence, drawing.id);
          const guestCount = guestCountFor(presence, drawing.id) ?? 0;
          return (
            <button
              key={drawing.id}
              type="button"
              onClick={() => onOpenDrawing(drawing.id)}
              aria-label={`Open ${drawing.name}, open right now`}
              className={clsx(
                "shrink-0 snap-start flex items-center gap-2 rounded-full border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 pl-1.5 pr-3 py-1.5 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-all hover:-translate-y-0.5 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]",
                "max-w-[220px]",
              )}
            >
              <MemberStack
                members={drawing.members?.items ?? []}
                onlineKeys={onlineKeys}
                max={3}
                size={20}
              />
              {guestCount > 0 && (drawing.members?.items.length ?? 0) === 0 && (
                <span className="h-5 w-5 flex items-center justify-center rounded-full border-2 border-dashed border-slate-400 dark:border-neutral-500 text-[9px] font-black text-slate-500 dark:text-neutral-300">
                  {guestCount}
                </span>
              )}
              <span className="truncate text-xs font-bold text-slate-700 dark:text-neutral-200">
                {drawing.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
