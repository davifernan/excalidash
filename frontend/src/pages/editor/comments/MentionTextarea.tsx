import React, { useMemo, useRef, useState } from "react";
import type { MentionCandidate } from "../../../api/comments";
import { mentionToken } from "./mentionTokens";

type Props = {
  value: string;
  onChange: (value: string) => void;
  candidates: MentionCandidate[];
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  disabled?: boolean;
  "data-testid"?: string;
};

/**
 * A plain textarea with an "@" trigger that inserts a structured
 * `@[Name](userId)` token -- never free text -- so the server never has to
 * guess who was meant. See mentionTokens.ts and the backend mention module.
 */
export const MentionTextarea: React.FC<Props> = ({
  value,
  onChange,
  candidates,
  placeholder,
  autoFocus,
  onSubmit,
  disabled,
  "data-testid": testId,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [triggerStart, setTriggerStart] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    if (triggerStart === null) return [];
    const q = query.toLowerCase();
    return candidates.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6);
  }, [candidates, triggerStart, query]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    onChange(next);
    const caret = event.target.selectionStart ?? next.length;
    const upToCaret = next.slice(0, caret);
    const atIndex = upToCaret.lastIndexOf("@");
    if (atIndex === -1 || /\s/.test(upToCaret.slice(atIndex + 1))) {
      setTriggerStart(null);
      return;
    }
    setTriggerStart(atIndex);
    setQuery(upToCaret.slice(atIndex + 1));
  };

  const insertMention = (candidate: MentionCandidate) => {
    if (triggerStart === null || !ref.current) return;
    const caret = ref.current.selectionStart ?? value.length;
    const before = value.slice(0, triggerStart);
    const after = value.slice(caret);
    const token = `${mentionToken(candidate.name, candidate.userId)} `;
    const next = `${before}${token}${after}`;
    onChange(next);
    setTriggerStart(null);
    setQuery("");
    requestAnimationFrame(() => {
      const cursor = before.length + token.length;
      ref.current?.focus();
      ref.current?.setSelectionRange(cursor, cursor);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      triggerStart !== null &&
      matches.length > 0 &&
      (event.key === "Enter" || event.key === "Tab")
    ) {
      event.preventDefault();
      insertMention(matches[0]);
      return;
    }
    if (triggerStart !== null && event.key === "Escape") {
      setTriggerStart(null);
      return;
    }
    if (triggerStart === null && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit?.();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        rows={3}
        maxLength={4000}
        data-testid={testId}
        className="w-full resize-none rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-2 text-xs font-medium text-slate-900 dark:text-neutral-100 focus:outline-none focus:border-indigo-600"
      />
      {triggerStart !== null && matches.length > 0 ? (
        <div
          className="absolute left-0 top-full mt-1 z-50 w-full max-w-[220px] rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] overflow-hidden"
          data-testid="mention-suggestions"
        >
          {matches.map((candidate) => (
            <button
              key={candidate.userId}
              type="button"
              onMouseDown={(event) => {
                // mousedown (not click) so the textarea does not blur first
                // and lose the caret position insertMention relies on.
                event.preventDefault();
                insertMention(candidate);
              }}
              className="w-full text-left px-2.5 py-1.5 text-xs font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
            >
              {candidate.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
