import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureEvent: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/react", () => sentry);

import {
  initializeErrorTracker,
  reportDiagnostic,
  reportRenderCrash,
  resetErrorTrackerForTests,
  scrubFrontendEvent,
  startErrorTracking,
} from "./errorTracker";
import {
  reportFailure,
  resetDiagnostics,
} from "./integrations/excalidraw/compatibility/diagnostics";
import { fail } from "./integrations/excalidraw/errors";

describe("frontend error tracker", () => {
  beforeEach(() => {
    resetErrorTrackerForTests();
    resetDiagnostics();
    window.__EXCALIDASH_RUNTIME_CONFIG__ = { errorTrackerDsn: "" };
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetErrorTrackerForTests();
    resetDiagnostics();
    delete window.__EXCALIDASH_RUNTIME_CONFIG__;
  });

  it("does not initialize, subscribe or send when the DSN is unset", () => {
    const stop = startErrorTracking();
    reportFailure(fail("editor-changed", "ui.toolbarSlot", { fallback: "main-menu" }), "0.18.1");
    reportRenderCrash("deadbeef", new Error("private board title"));
    stop();

    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureEvent).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("initializes with PII disabled and the scrubber installed before sending", () => {
    expect(initializeErrorTracker("http://public@example.test/1")).toBe(true);
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        sendDefaultPii: false,
        defaultIntegrations: false,
        maxBreadcrumbs: 0,
        beforeSend: scrubFrontendEvent,
      }),
    );
  });

  it("subscribes the app shell to the content-free adapter diagnostic shape", () => {
    window.__EXCALIDASH_RUNTIME_CONFIG__ = {
      errorTrackerDsn: "http://public@example.test/1",
    };
    const stop = startErrorTracking();
    reportFailure(
      fail("invalid-state", "scene.apply", {
        detail: "element 'Q3 revenue' is locked",
        fallback: "retry",
      }),
      "0.18.1",
    );
    stop();

    expect(sentry.captureEvent).toHaveBeenCalledWith({
      message: "Excalidraw compatibility failure",
      level: "error",
      fingerprint: ["adapter", "scene.apply", "invalid-state"],
      tags: {
        source: "adapter",
        seam: "scene.apply",
        code: "invalid-state",
        fallback: "retry",
        packageVersion: "0.18.1",
      },
    });
    expect(JSON.stringify(sentry.captureEvent.mock.calls)).not.toContain("Q3 revenue");
  });

  it("reports an error-boundary crash without the original error or component stack", () => {
    initializeErrorTracker("http://public@example.test/1");
    const original = new Error("private board title");
    reportRenderCrash("deadbeef", original);

    const [error, context] = sentry.captureException.mock.calls[0];
    expect(error).toBe(original);
    expect(context).toEqual({ tags: { source: "error-boundary", errorId: "deadbeef" } });
  });

  it("removes component props, board content, filenames and identities in beforeSend", () => {
    const scrubbed = scrubFrontendEvent({
      message: "render of Q3 board failed",
      user: { id: "user-raw-123", email: "person@example.test" },
      request: { url: "https://app.test/drawings/board-raw-456" },
      breadcrumbs: [{ message: "opened private-report.pdf" }],
      extra: { componentStack: '<Board title="Q3 revenue" file="private-report.pdf">' },
      tags: { source: "error-boundary", errorId: "deadbeef", userId: "user-raw-123" },
      exception: {
        values: [
          {
            type: "Error",
            value: "Q3 revenue for person@example.test",
            stacktrace: {
              frames: [
                {
                  filename: "https://app.test/assets/index-abcd.js",
                  function: "render",
                  lineno: 1,
                },
              ],
            },
          },
        ],
      },
    });

    expect(scrubbed.tags).toEqual({ source: "error-boundary", errorId: "deadbeef" });
    expect(scrubbed.exception?.values?.[0]).toMatchObject({
      type: "FrontendRenderError",
      value: "Frontend render crash",
      stacktrace: { frames: [{ filename: "app:///assets/index-abcd.js" }] },
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(
      /Q3|person@example\.test|user-raw|board-raw|private-report|componentStack/i,
    );
  });

  it("can call the direct diagnostic reporter only after initialization", () => {
    reportDiagnostic({
      seam: "scene.apply",
      code: "invalid-state",
      fallback: "retry",
      packageVersion: "0.18.1",
    });
    expect(sentry.captureEvent).not.toHaveBeenCalled();
  });
});
