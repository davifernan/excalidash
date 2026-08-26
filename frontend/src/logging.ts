import { toast } from "sonner";
import { structuredLogReplacer as errorReplacer, type LogFields } from "@excalidash/domain/shared";

/**
 * The one place frontend code writes a log line (NIL-510/NIL-513) -- the
 * frontend mirror of `backend/src/logger.ts` (NIL-411/NIL-502/NIL-504), with
 * one difference that changes the design: the receiver is not the same.
 *
 * A backend `logger.error` call reaches a file or an aggregator someone
 * reads later. A frontend log line happens inside one person's browser tab;
 * `console.error` there reaches nobody unless that exact person happens to
 * have devtools open at that exact moment. `AppErrorBoundary` (NIL-411)
 * already solved this correctly for a render crash: a console line AND a UI
 * surface, carrying the same reference id, "visible instead of silent."
 * `log.error()` generalizes that pairing to every handled failure, not only
 * an uncaught one: it always writes a structured console line, and unless
 * told otherwise, also raises a toast (`sonner`, already this app's one
 * toast mechanism) carrying the same reference id -- so by default, a human
 * sees it in the moment a failure happens, not only in devtools nobody has
 * open.
 *
 * Pass `{ notify: false }` at a call site that already shows its own
 * specific, friendlier message right after catching the same error (most
 * dashboard/editor catch blocks do -- e.g.
 * `useDashboardDrawingActions.ts`'s `handleViewerActionError`). That is a
 * deliberate, visible annotation at the call site, not a silent skip --
 * the same "named exception, not a silent one" rule every boundary check in
 * this repo already follows for its own exception lists. Leaving `notify`
 * at its default is itself a decision: it means nothing else was telling
 * the user this failed, and migrating the call site here is what gives that
 * failure a reader for the first time.
 */
export type { LogFields } from "@excalidash/domain/shared";

export interface ErrorLogOptions {
  /** Show a toast carrying the reference id. Default true -- see file comment. */
  notify?: boolean;
}

const newRef = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.slice(0, 8);
  return Math.random().toString(16).slice(2, 10);
};

/**
 * `JSON.stringify(new Error("x"))` is `"{}"` -- `message` and `stack` are
 * non-enumerable own properties the default serializer drops silently.
 * Same fix as `backend/src/logger.ts`'s replacer, for the same reason: an
 * Error passed in `fields` must not vanish without an error of its own.
 */
// A live property lookup, not a captured reference -- console[level] re-reads
// console.error/warn/info/debug on every call, the same way the code this
// replaced did. A lookup table built once at module load would freeze in
// whatever those methods were at import time, which breaks any test (or
// runtime patch) that replaces console.error after this module first loads.
const consoleFor = (level: "error" | "warn" | "info" | "debug") => console[level];

const write = (level: "error" | "warn" | "info" | "debug", message: string, fields?: LogFields) => {
  const line = { time: new Date().toISOString(), level, message, ...fields };
  consoleFor(level)(JSON.stringify(line, errorReplacer));
};

export const log = {
  /**
   * Always writes a structured console line. Also raises a toast with the
   * reference id unless `{ notify: false }` is passed. Returns the
   * reference id so a caller that builds its own message can include it.
   */
  error(message: string, fields?: LogFields, options?: ErrorLogOptions): string {
    const ref = newRef();
    write("error", message, { ...fields, ref });
    if (options?.notify !== false) {
      toast.error(message, { description: `Reference ${ref}` });
    }
    return ref;
  },
  /** Console-only. Use for a caught problem that a UI element already surfaces, or that is not user-facing. */
  warn(message: string, fields?: LogFields): void {
    write("warn", message, fields);
  },
  /** Console-only, always written. Use for routine operational detail worth keeping, not a failure. */
  info(message: string, fields?: LogFields): void {
    write("info", message, fields);
  },
  /** Console-only, dev builds only -- verbose tracing that would otherwise ship to every user's console. */
  debug(message: string, fields?: LogFields): void {
    if (import.meta.env.DEV) write("debug", message, fields);
  },
};
