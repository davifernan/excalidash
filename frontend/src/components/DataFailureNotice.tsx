import React from "react";
import clsx from "clsx";
import { AlertTriangle } from "lucide-react";

export const DataFailureNotice: React.FC<{
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}> = ({ message, onRetry, compact = false }) => (
  <div
    role="alert"
    className={clsx(
      "mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-950 dark:text-amber-100 rounded-xl",
      compact ? "px-4 py-3" : "px-5 py-5",
    )}
  >
    <div className="flex items-start gap-3">
      <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="text-sm font-bold">{message}</span>
    </div>
    {onRetry && (
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-lg border-2 border-black dark:border-neutral-600 bg-white dark:bg-neutral-900 px-4 py-2 text-sm font-bold text-neutral-900 dark:text-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
      >
        Try again
      </button>
    )}
  </div>
);
