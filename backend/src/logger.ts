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
    ...fields,
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
