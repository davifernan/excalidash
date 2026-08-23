import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "./errorHandler";

describe("errorHandler upload limits", () => {
  it("turns the streaming multipart ceiling into a structured 413", () => {
    const status = vi.fn();
    const json = vi.fn();
    const response = { status: status.mockReturnValue({ json }) };
    const error = Object.assign(new Error("File too large"), { code: "LIMIT_FILE_SIZE" });

    errorHandler(
      error,
      {
        path: "/import/sqlite/legacy",
        method: "POST",
        headers: { "x-request-id": "req-7" },
      } as any,
      response as any,
      vi.fn(),
    );

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      code: "upload-too-large",
      error: "Payload too large",
      message: "The upload exceeds the configured backend limit.",
      requestId: "req-7",
    });
  });
});

describe("errorHandler correlation", () => {
  const respond = () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    return { response: { status } as never, status, json };
  };

  const request = (requestId?: string) =>
    ({
      path: "/drawings",
      method: "GET",
      headers: requestId ? { "x-request-id": requestId } : {},
    }) as never;

  it("logs the failing request under the same key as every other one", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { response } = respond();

    errorHandler(new Error("nope"), request("req-42"), response, vi.fn());

    expect(error.mock.calls[0][1]).toMatchObject({ requestId: "req-42" });
    error.mockRestore();
  });

  it("returns the key, so a report and a log line can be matched up", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, json } = respond();

    errorHandler(new Error("nope"), request("req-42"), response, vi.fn());

    expect(json.mock.calls[0][0]).toMatchObject({ requestId: "req-42" });
    vi.restoreAllMocks();
  });

  it("says unknown rather than inventing a key when the header is missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, json } = respond();

    errorHandler(new Error("nope"), request(), response, vi.fn());

    expect(json.mock.calls[0][0]).toMatchObject({ requestId: "unknown" });
    vi.restoreAllMocks();
  });

  it("still keeps the internals out of a production response", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, json } = respond();

    errorHandler(
      Object.assign(new Error("SELECT * FROM users failed at /app/src/db.ts"), {
        statusCode: 500,
      }),
      request("req-42"),
      response,
      vi.fn(),
    );

    const body = JSON.stringify(json.mock.calls[0][0]);
    expect(body).not.toContain("SELECT");
    expect(body).not.toContain("/app/src");
    expect(body).toContain("req-42");
    vi.restoreAllMocks();
  });
});
