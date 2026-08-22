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
      { path: "/import/sqlite/legacy", method: "POST" } as any,
      response as any,
      vi.fn(),
    );

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      code: "upload-too-large",
      error: "Payload too large",
      message: "The upload exceeds the configured backend limit.",
    });
  });
});
