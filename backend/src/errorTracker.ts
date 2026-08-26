import * as Sentry from "@sentry/node";
import type { ErrorEvent, StackFrame } from "@sentry/node";
import { isSafeTelemetryToken } from "@excalidash/domain/shared";

import { config } from "./config";
import type { LogFields } from "./logger";

const TRACKER_MESSAGE = "Backend error";
const SAFE_TAG_KEYS = new Set(["requestId", "statusCode", "method", "code", "event"]);
const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/;

let enabled = false;

const safeScalar = (key: string, value: unknown): string | number | boolean | undefined => {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (key === "method") return HTTP_METHOD.test(value) ? value : undefined;
  return isSafeTelemetryToken(value) ? value : undefined;
};

const safeCodeFrame = (frame: StackFrame): StackFrame => {
  const location = frame.filename?.match(/\/(dist|src)\/([A-Za-z0-9_./-]+)$/);
  const filename = location ? `app:///${location[1]}/${location[2]}` : undefined;
  return {
    filename: filename && !/[?#]/.test(filename) ? filename : undefined,
    function: frame.function && isSafeTelemetryToken(frame.function) ? frame.function : undefined,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
};

const safeCodeFrames = (frames: StackFrame[]): StackFrame[] =>
  frames
    .map(safeCodeFrame)
    .filter(
      (frame) =>
        frame.filename !== "app:///dist/errorTracker.js" &&
        frame.filename !== "app:///src/errorTracker.ts" &&
        frame.filename !== "app:///dist/logger.js" &&
        frame.filename !== "app:///src/logger.ts",
    );

const safeTags = (tags: ErrorEvent["tags"]): ErrorEvent["tags"] => {
  const result: NonNullable<ErrorEvent["tags"]> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (!SAFE_TAG_KEYS.has(key)) continue;
    const safe = safeScalar(key, value);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
};

/**
 * Last line of defence before an event leaves the process.
 *
 * Rebuilding the event is intentional. Logger fields include email addresses,
 * user/board ids, S3 object keys and stored-file paths at busy auth/storage call
 * sites. An exclusion list would leak the next field somebody adds. The tracker
 * therefore receives only a synthetic exception, code locations and five
 * explicitly safe correlation/classification tags; request data, breadcrumbs,
 * user data, arbitrary extras and original Error messages never cross the wire.
 */
export const scrubBackendEvent = (event: ErrorEvent): ErrorEvent => ({
  type: undefined,
  event_id: event.event_id,
  timestamp: event.timestamp,
  platform: event.platform,
  level: "error",
  exception: {
    values: (event.exception?.values ?? []).map((value) => ({
      type: "BackendError",
      value: TRACKER_MESSAGE,
      stacktrace: value.stacktrace
        ? { frames: safeCodeFrames(value.stacktrace.frames ?? []) }
        : undefined,
    })),
  },
  tags: safeTags(event.tags),
});

export const initializeErrorTracker = (dsn: string | null = config.errorTrackerDsn): boolean => {
  if (!dsn) {
    enabled = false;
    return false;
  }

  Sentry.init({
    dsn,
    sendDefaultPii: false,
    defaultIntegrations: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    beforeSend: scrubBackendEvent,
  });
  enabled = true;
  return true;
};

const trackerTags = (fields?: LogFields): Record<string, string | number | boolean> => {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!SAFE_TAG_KEYS.has(key)) continue;
    const safe = safeScalar(key, value);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
};

export const reportBackendError = (fields?: LogFields): void => {
  if (!enabled) return;
  try {
    const original = fields?.error instanceof Error ? fields.error : undefined;
    const error = original ?? new Error(TRACKER_MESSAGE);
    if (!original) {
      error.name = "BackendError";
      Error.captureStackTrace(error, reportBackendError);
    }
    Sentry.captureException(error, { tags: trackerTags(fields) });
  } catch {
    // Reporting must never turn the application's existing error path into a second failure.
  }
};

export const flushErrorTracker = (timeoutMs = 5_000): Promise<boolean> =>
  enabled ? Sentry.flush(timeoutMs) : Promise.resolve(true);

/** Test seam: the production lifecycle enables the tracker only once at startup. */
export const resetErrorTrackerForTests = (): void => {
  enabled = false;
};

initializeErrorTracker();
