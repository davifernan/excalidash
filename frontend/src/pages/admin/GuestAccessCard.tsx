import React from "react";
import { UserRoundCog } from "lucide-react";

type GuestAccessCardProps = {
  uploadFiles: boolean | null;
  viewComments: boolean | null;
  loading: boolean;
  onToggleUploadFiles: () => void | Promise<void>;
  onToggleViewComments: () => void | Promise<void>;
};

const toggleLabel = (value: boolean | null, loading: boolean) => {
  if (value === null) return "Loading…";
  if (loading) return "Saving…";
  return value ? "Enabled" : "Disabled";
};

const toggleClassName = (value: boolean | null) =>
  `w-full px-4 py-3 rounded-xl border-2 font-bold transition-all text-sm ${
    value
      ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300"
      : "border-slate-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-slate-600 dark:text-neutral-300"
  }`;

/**
 * NIL-633's admin half. This is the ceiling from NIL-615: a board owner can
 * narrow either capability for their own board, but never raise it past what
 * is set here -- see GuestCapabilitiesSection.tsx in the share dialog.
 */
export const GuestAccessCard: React.FC<GuestAccessCardProps> = ({
  uploadFiles,
  viewComments,
  loading,
  onToggleUploadFiles,
  onToggleViewComments,
}) => (
  <div className="mb-6 bg-white dark:bg-neutral-900 border-2 border-black dark:border-neutral-700 rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] p-4 sm:p-6">
    <div className="flex items-center gap-3 mb-4">
      <div className="w-12 h-12 bg-emerald-50 dark:bg-neutral-800 rounded-xl flex items-center justify-center border-2 border-emerald-100 dark:border-neutral-700">
        <UserRoundCog size={24} className="text-emerald-700 dark:text-emerald-300" />
      </div>
      <div className="min-w-0">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Guest Access</h2>
        <p className="text-sm text-slate-600 dark:text-neutral-400 font-medium">
          The instance-wide ceiling. A board can only narrow this, never raise it.
        </p>
      </div>
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <label className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-2">
          Guest file uploads
        </label>
        <button
          type="button"
          onClick={() => void onToggleUploadFiles()}
          disabled={loading || uploadFiles === null}
          className={toggleClassName(uploadFiles)}
        >
          {toggleLabel(uploadFiles, loading)}
        </button>
      </div>
      <div>
        <label className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-2">
          Guest comment visibility
        </label>
        <button
          type="button"
          onClick={() => void onToggleViewComments()}
          disabled={loading || viewComments === null}
          className={toggleClassName(viewComments)}
        >
          {toggleLabel(viewComments, loading)}
        </button>
      </div>
    </div>
  </div>
);
