/**
 * The "Import mind map..." dialog (NIL-572): paste an outline or a limited
 * Markdown subset, see what would be written BEFORE anything is written,
 * then commit.
 *
 * The preview is the point of this dialog, not a courtesy on top of it: the
 * ticket's own user contract is explicit that an import which just goes
 * ahead and leaves 200 nodes behind is worse than one that asks first. The
 * "Import" button only exists once `parseOutline` (`outlineParser.ts`)
 * reports success -- a rejected outline shows its errors, each with the
 * exact source line, and offers only "Back", never "Import anyway".
 *
 * Same portal/focus-trap/Escape shape as `ConfirmModal.tsx`, kept
 * deliberately self-contained here rather than generalizing that component:
 * this dialog has a two-stage flow (edit -> preview) `ConfirmModal` has no
 * concept of, and forcing that shape into a single shared component would
 * make the confirm-only case harder to read for the size of the win.
 */
import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { parseOutline, type ParseResult } from "./outlineParser";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onImport: (result: Extract<ParseResult, { ok: true }>) => void;
};

export const MindMapImportDialog: React.FC<Props> = ({ isOpen, onClose, onImport }) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setText("");
      setResult(null);
      return;
    }
    textareaRef.current?.focus();

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePreview = () => setResult(parseOutline(text));
  const handleBack = () => setResult(null);
  const handleImport = () => {
    if (result?.ok) onImport(result);
  };

  return createPortal(
    <div className="excalidash-z-modal fixed inset-0 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-neutral-900/20 backdrop-blur-sm" onClick={onClose} />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-lg bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.08)] p-6"
      >
        <button
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute right-4 top-4 text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
        >
          <X size={20} />
        </button>

        <h3
          id={titleId}
          className="text-xl font-bold text-neutral-900 dark:text-neutral-100 tracking-tight mb-1"
        >
          Import mind map
        </h3>
        <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 mb-4">
          Paste an indented outline, or Markdown headings and nested lists. Nothing is written until
          you confirm the preview.
        </p>

        {result === null ? (
          <>
            <textarea
              ref={textareaRef}
              data-testid="mind-map-import-textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={10}
              placeholder={"Project X\n  Design\n    Wireframes\n  Development"}
              className="w-full font-mono text-sm p-3 rounded-xl border-2 border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-indigo-400"
            />
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={onClose}
                className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 font-bold rounded-xl border-2 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-all duration-200"
              >
                Cancel
              </button>
              <button
                data-testid="mind-map-import-preview"
                onClick={handlePreview}
                disabled={text.trim().length === 0}
                className="px-4 py-2.5 bg-indigo-600 text-white font-bold rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-40 disabled:hover:shadow-none disabled:hover:translate-y-0"
              >
                Preview
              </button>
            </div>
          </>
        ) : result.ok ? (
          <>
            <div
              data-testid="mind-map-import-preview-result"
              className="rounded-xl border-2 border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/20 p-4 flex items-start gap-3"
            >
              <CheckCircle2
                size={20}
                className="text-emerald-600 dark:text-emerald-300 shrink-0 mt-0.5"
              />
              <div className="text-sm text-neutral-800 dark:text-neutral-100">
                <p className="font-bold">"{result.summary.rootText}"</p>
                <p>
                  {result.summary.nodeCount} node{result.summary.nodeCount === 1 ? "" : "s"} across{" "}
                  {result.summary.levelCount} level{result.summary.levelCount === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            {result.summary.warnings.length > 0 && (
              <ul
                data-testid="mind-map-import-warnings"
                className="mt-3 space-y-1 text-sm text-amber-700 dark:text-amber-300"
              >
                {result.summary.warnings.map((warning) => (
                  <li key={`${warning.line}-${warning.message}`}>
                    Zeile {warning.line}: {warning.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={handleBack}
                className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 font-bold rounded-xl border-2 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-all duration-200"
              >
                Back
              </button>
              <button
                data-testid="mind-map-import-confirm"
                onClick={handleImport}
                className="px-4 py-2.5 bg-indigo-600 text-white font-bold rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-all duration-200"
              >
                Import
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              data-testid="mind-map-import-errors"
              className="rounded-xl border-2 border-rose-200 dark:border-rose-900/40 bg-rose-50 dark:bg-rose-900/20 p-4 flex items-start gap-3"
            >
              <AlertTriangle
                size={20}
                className="text-rose-600 dark:text-rose-300 shrink-0 mt-0.5"
              />
              <ul className="text-sm text-neutral-800 dark:text-neutral-100 space-y-1">
                {result.errors.map((error) => (
                  <li key={`${error.line}-${error.message}`}>
                    Zeile {error.line}: {error.message}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={handleBack}
                className="px-4 py-2.5 bg-indigo-600 text-white font-bold rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-all duration-200"
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
