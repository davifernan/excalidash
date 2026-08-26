import { config } from "./config";
import { reportBackendError } from "./errorTracker";

/**
 * The one place backend code writes a log line (NIL-411/NIL-502).
 *
 * Before this file, "the backend error path loses its thread" meant two
 * separate things: a caught error had nothing but `console.error(message,
 * error)` -- no level, no request/socket id, no consistent shape a log
 * aggregator could group on -- and there was no single place to fix that
 * once. `scripts/logging-boundary.cjs` makes this the only legal place:
 * every other file that wants to log calls one of these four functions
 * instead of `console.*` directly.
 *
 * `fields` is a flat object merged into the line, not a message template --
 * `logger.error("drawing save failed", { requestId, drawingId })` instead of
 * `console.error(\`drawing save failed for ${drawingId}\`)`, so a
 * correlation id is always a queryable field, never buried in a string a
 * log aggregator has to regex out.
 *
 * Level gating reuses `config.logLevel` (silent|info|debug) from NIL-411
 * rather than inventing a second scheme: "silent" mutes info/debug/warn the
 * same way it already mutes per-request lines in requestLog.ts. `error`
 * always writes, at every level -- an error is exactly the thing a level
 * knob must never be able to hide.
 */
export type LogFields = Record<string, unknown>;

/**
 * `JSON.stringify(new Error("x"))` is `"{}"` -- `message` and `stack` are
 * non-enumerable own properties, so the default serializer drops them
 * silently. A field holding an Error (an obvious, common thing to log) would
 * otherwise vanish without an error of its own -- exactly the kind of silent
 * loss this module exists to end. The replacer runs on every nested value,
 * so an Error buried inside a fields object is caught too, not only a
 * top-level one.
 */
const errorReplacer = (_key: string, value: unknown) =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;

/**
 * NIL-619: this log now survives a week or more instead of a rotating
 * few-hour window, so a field that was momentarily risky becomes a
 * durably-retained one. `errorTracker.ts`'s `SAFE_TAG_KEYS` solves the
 * mirror problem for Sentry with an ALLOWLIST of five tags -- that works
 * there because Sentry gets a synthetic exception and a handful of
 * correlation tags, nothing else. This log is the opposite kind of thing:
 * dozens of call sites pass whatever field actually helps trace a request
 * (drawingId, elementId, existingRows, statusCode, ...), and an allowlist
 * narrow enough to be provably safe would gut the log's entire purpose.
 *
 * So this is a narrow, named DENYLIST instead -- matched by key name, not
 * content, against the specific classes NIL-619 was asked to check for
 * (tokens, addresses): `email`/`userEmail` (an actual address was already
 * reaching production logs today, in `adminUserRoutes.ts`'s invitation
 * failure path) and any *token/*secret/*password/*authorization/*cookie/
 * *apikey/*jwt field. A denylist can miss the next field somebody adds --
 * that risk is accepted here because the alternative (an allowlist) would
 * also silently miss the next field, just in the other direction: dropping
 * it from the log entirely with no signal that anything was lost. A
 * redacted key is still visible as "redacted"; a field an allowlist never
 * knew to keep looks identical to one that was never logged.
 *
 * What this does NOT cover: a raw `Error.message`/`stack` that happens to
 * echo back user input (a validation library quoting the rejected value,
 * say). `errorTracker.ts` sidesteps that by never forwarding the original
 * message at all; this log keeps it on purpose, because the message and
 * stack are usually exactly what a real incident needs. Redacting or
 * dropping messages/stacks wholesale would defeat NIL-619's point. If a
 * concrete leak through an error message ever turns up, that is a
 * genuinely separate fix (at the throw site, not here) and needs its own
 * ticket -- this module has no way to know what a message means.
 */
const REDACTED_KEY_PATTERN = /token|secret|password|authorization|cookie|apikey|jwt|email/i;
const REDACTED_VALUE = "[redacted]";

const redactFields = (fields: LogFields | undefined): LogFields | undefined => {
  if (!fields) return fields;
  let changed = false;
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEY_PATTERN.test(key)) {
      result[key] = REDACTED_VALUE;
      changed = true;
    } else {
      result[key] = value;
    }
  }
  return changed ? result : fields;
};

const write = (
  stream: NodeJS.WritableStream,
  level: string,
  message: string,
  fields?: LogFields,
) => {
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...redactFields(fields),
  };
  stream.write(`${JSON.stringify(line, errorReplacer)}\n`);
};

export const logger = {
  /** Always written, regardless of LOG_LEVEL -- see the file comment above. */
  error(message: string, fields?: LogFields): void {
    write(process.stderr, "error", message, fields);
    reportBackendError(fields);
  },
  warn(message: string, fields?: LogFields): void {
    if (config.logLevel === "silent") return;
    write(process.stderr, "warn", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    if (config.logLevel === "silent") return;
    write(process.stdout, "info", message, fields);
  },
  /** Only at LOG_LEVEL=debug -- per-request/verbose tracing. */
  debug(message: string, fields?: LogFields): void {
    if (config.logLevel !== "debug") return;
    write(process.stdout, "debug", message, fields);
  },
};
