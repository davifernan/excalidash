import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));

vi.mock("@sentry/node", () => sentry);

import {
  initializeErrorTracker,
  reportBackendError,
  resetErrorTrackerForTests,
  scrubBackendEvent,
} from "./errorTracker";

describe("backend error tracker", () => {
  beforeEach(() => {
    resetErrorTrackerForTests();
    vi.clearAllMocks();
  });

  afterEach(() => resetErrorTrackerForTests());

  it("does not initialize or send when the DSN is unset", () => {
    expect(initializeErrorTracker(null)).toBe(false);
    reportBackendError({ requestId: "req-1" });
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("initializes with PII disabled and the scrubber installed before sending", () => {
    expect(initializeErrorTracker("http://public@example.test/1")).toBe(true);
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        sendDefaultPii: false,
        defaultIntegrations: false,
        maxBreadcrumbs: 0,
        beforeSend: scrubBackendEvent,
      }),
    );
  });

  it("projects busy auth and S3 fields onto a safe allowlist", () => {
    initializeErrorTracker("http://public@example.test/1");
    reportBackendError({
      requestId: "req-123",
      statusCode: 503,
      method: "POST",
      email: "person@example.test",
      userId: "user-raw-123",
      drawingId: "board-raw-456",
      key: "excalidash/user-raw-123/board-raw-456/file-name.png",
      path: "/app/prisma/assets/private-report.pdf",
      error: new Error("failed for person@example.test/private-report.pdf"),
    });

    const context = sentry.captureException.mock.calls[0][1];
    expect(context).toEqual({
      tags: { requestId: "req-123", statusCode: 503, method: "POST" },
    });
    expect(JSON.stringify(context)).not.toMatch(
      /person@example\.test|user-raw|board-raw|file-name|private-report/i,
    );
  });

  it("rebuilds the final event and removes content, filenames and raw identities", () => {
    const scrubbed = scrubBackendEvent({
      message: "Q3 board contents",
      user: { id: "user-raw-123", email: "person@example.test" },
      request: { url: "https://app.test/drawings/board-raw-456" },
      breadcrumbs: [{ message: "opened private-report.pdf" }],
      extra: { elementText: "Q3 revenue", fileName: "private-report.pdf" },
      tags: {
        requestId: "req-123",
        statusCode: 500,
        method: "POST",
        userId: "user-raw-123",
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "failed for person@example.test/private-report.pdf",
            stacktrace: {
              frames: [
                {
                  filename: "/app/dist/auth/coreRoutes.js",
                  function: "login",
                  lineno: 503,
                },
              ],
            },
          },
        ],
      },
    });

    expect(scrubbed.tags).toEqual({ requestId: "req-123", statusCode: 500, method: "POST" });
    expect(scrubbed.exception?.values?.[0]).toMatchObject({
      type: "BackendError",
      value: "Backend error",
      stacktrace: { frames: [{ filename: "app:///dist/auth/coreRoutes.js" }] },
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(
      /Q3|person@example\.test|user-raw|board-raw|private-report/i,
    );
  });
});
