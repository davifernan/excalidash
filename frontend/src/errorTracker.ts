import * as Sentry from "@sentry/react";
import type { ErrorEvent, StackFrame } from "@sentry/react";

import type { DiagnosticEvent } from "./integrations/excalidraw/capabilities";
import { onDiagnostic } from "./integrations/excalidraw/compatibility/diagnostics";

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,100}$/;
const SAFE_TAG_KEYS = new Set(["source", "errorId", "seam", "code", "fallback", "packageVersion"]);
const RENDER_CRASH = "Frontend render crash";
const ADAPTER_FAILURE = "Excalidraw compatibility failure";

let enabled = false;

declare global {
  interface Window {
    __EXCALIDASH_RUNTIME_CONFIG__?: {
      errorTrackerDsn?: string;
    };
  }
}

const configuredDsn = (): string | null => {
  const runtime = window.__EXCALIDASH_RUNTIME_CONFIG__?.errorTrackerDsn?.trim();
  if (runtime) return runtime;
  const built = import.meta.env.VITE_ERROR_TRACKER_DSN?.trim();
  return built || null;
};

const safeCodeFrame = (frame: StackFrame): StackFrame => {
  const location = frame.filename?.match(/\/(assets|src)\/([A-Za-z0-9_./-]+)$/);
  const filename = location ? `app:///${location[1]}/${location[2]}` : undefined;
  return {
    filename: filename && !/[?#]/.test(filename) ? filename : undefined,
    function: frame.function && SAFE_TOKEN.test(frame.function) ? frame.function : undefined,
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
        frame.filename !== "app:///assets/errorTracker.js" &&
        frame.filename !== "app:///src/errorTracker.ts",
    );

const safeTags = (tags: ErrorEvent["tags"]): ErrorEvent["tags"] => {
  const result: NonNullable<ErrorEvent["tags"]> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (!SAFE_TAG_KEYS.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") result[key] = value;
    if (typeof value === "string" && SAFE_TOKEN.test(value)) result[key] = value;
  }
  return result;
};

/** Rebuild, rather than subtract from, the browser event sent over the wire. */
export const scrubFrontendEvent = (event: ErrorEvent): ErrorEvent => ({
  type: undefined,
  event_id: event.event_id,
  timestamp: event.timestamp,
  platform: event.platform,
  level: "error",
  message: event.message === ADAPTER_FAILURE ? ADAPTER_FAILURE : undefined,
  fingerprint:
    event.message === ADAPTER_FAILURE && event.fingerprint
      ? event.fingerprint.filter((part) => SAFE_TOKEN.test(part))
      : undefined,
  exception: event.exception
    ? {
        values: (event.exception.values ?? []).map((value) => ({
          type: "FrontendRenderError",
          value: RENDER_CRASH,
          stacktrace: value.stacktrace
            ? { frames: safeCodeFrames(value.stacktrace.frames ?? []) }
            : undefined,
        })),
      }
    : undefined,
  tags: safeTags(event.tags),
});

export const initializeErrorTracker = (dsn: string | null = configuredDsn()): boolean => {
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
    beforeSend: scrubFrontendEvent,
  });
  enabled = true;
  return true;
};

export const reportDiagnostic = (event: DiagnosticEvent): void => {
  if (!enabled) return;
  try {
    Sentry.captureEvent({
      message: ADAPTER_FAILURE,
      level: "error",
      fingerprint: ["adapter", event.seam, event.code],
      tags: { source: "adapter", ...event },
    });
  } catch {
    // A reporting failure must not break the adapter fallback it is observing.
  }
};

export const reportRenderCrash = (errorId: string, error: Error): void => {
  if (!enabled) return;
  try {
    Sentry.captureException(error, { tags: { source: "error-boundary", errorId } });
  } catch {
    // The visible AppErrorBoundary fallback remains the source of truth.
  }
};

export const startErrorTracking = (): (() => void) => {
  if (!initializeErrorTracker()) return () => undefined;
  return onDiagnostic(reportDiagnostic);
};

/** Test seam: the production lifecycle enables the tracker only once at startup. */
export const resetErrorTrackerForTests = (): void => {
  enabled = false;
};
