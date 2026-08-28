import React from "react";
import clsx from "clsx";
import { MessageSquare, ShieldAlert, Upload } from "lucide-react";
import type { GuestCapabilitySettings } from "../../api";
import { CustomSelect } from "./CustomSelect";

type Props = {
  settings: GuestCapabilitySettings | null;
  onToggleUploadFiles: () => void | Promise<void>;
  onToggleViewComments: () => void | Promise<void>;
};

const ON_OFF_OPTIONS = [
  { label: "Off", value: "off" },
  { label: "On", value: "on" },
];

type RowProps = {
  icon: React.ReactNode;
  title: string;
  board: boolean;
  instanceAllowed: boolean;
  effective: boolean;
  effectiveLabel: string;
  ineffectiveLabel: string;
  onToggle: () => void | Promise<void>;
};

/**
 * One capability row. `board` is this drawing's own opt-in and is what the
 * toggle here controls; `instanceAllowed` is the admin ceiling (Admin ->
 * Guest Access) that this board can never raise, only narrow further --
 * turning the toggle here off still works while the instance is off, but
 * turning it on has no effect until an admin allows it too.
 */
const CapabilityRow: React.FC<RowProps> = ({
  icon,
  title,
  board,
  instanceAllowed,
  effective,
  effectiveLabel,
  ineffectiveLabel,
  onToggle,
}) => (
  <div className="flex items-start gap-4 px-1">
    <div
      className={clsx(
        "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border-2 mt-0.5",
        effective
          ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border-emerald-600 dark:border-emerald-500"
          : "bg-slate-50 dark:bg-neutral-800 text-slate-400 dark:text-neutral-500 border-slate-400 dark:border-neutral-600",
      )}
    >
      {icon}
    </div>
    <div className="flex-1 min-w-0 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-black text-slate-700 dark:text-neutral-200">{title}</span>
        <div className={clsx(!instanceAllowed && "opacity-50 pointer-events-none")}>
          <CustomSelect
            value={board ? "on" : "off"}
            onChange={() => void onToggle()}
            options={ON_OFF_OPTIONS}
            variant="bordered"
            showCheck={false}
          />
        </div>
      </div>
      {!instanceAllowed ? (
        <p className="text-[10px] font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1">
          <ShieldAlert size={11} strokeWidth={2.5} />
          Disabled instance-wide by an admin -- this board cannot turn it back on.
        </p>
      ) : (
        <p className="text-[10px] font-bold text-slate-500 dark:text-neutral-400">
          {effective ? effectiveLabel : ineffectiveLabel}
        </p>
      )}
    </div>
  </div>
);

/**
 * NIL-633's board half of NIL-615's guest policy, next to General access
 * because both are about what a link guest -- not a member -- can do. Only
 * ever rendered while ShareModal itself is open, which already required
 * controlsDrawing on `/drawings/:id/sharing`; the toggles here still go
 * through their own controlsDrawing check server-side.
 */
export const GuestCapabilitiesSection: React.FC<Props> = ({
  settings,
  onToggleUploadFiles,
  onToggleViewComments,
}) => {
  if (!settings) return null;

  return (
    <section className="pt-5 border-t-2 border-black dark:border-neutral-700">
      <h3 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-neutral-500 px-1 mb-3">
        Guest capabilities
      </h3>
      <div className="space-y-4">
        <CapabilityRow
          icon={<Upload size={16} strokeWidth={2.5} />}
          title="Upload files"
          board={settings.board.uploadFiles}
          instanceAllowed={settings.instance.uploadFiles}
          effective={settings.effective.uploadFiles}
          effectiveLabel="Guests with edit access can upload files here."
          ineffectiveLabel="Guests with edit access cannot upload files here."
          onToggle={onToggleUploadFiles}
        />
        <CapabilityRow
          icon={<MessageSquare size={16} strokeWidth={2.5} />}
          title="See comments"
          board={settings.board.viewComments}
          instanceAllowed={settings.instance.viewComments}
          effective={settings.effective.viewComments}
          effectiveLabel="Guests can see comments on this board."
          ineffectiveLabel="Guests cannot see comments on this board."
          onToggle={onToggleViewComments}
        />
      </div>
    </section>
  );
};
