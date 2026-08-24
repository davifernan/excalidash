import { describe, it, expect } from "vitest";
import { decodeDataURL } from "../fileProcessing";

/** Tiny valid 1x1 PNG as a base64 data URL */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

describe("decodeDataURL", () => {
  it("decodes a valid base64 data URL", () => {
    const result = decodeDataURL(PNG_DATA_URL);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/png");
    expect(Buffer.isBuffer(result!.buffer)).toBe(true);
    expect(result!.buffer.length).toBeGreaterThan(0);
  });

  it("returns null for non-data URLs", () => {
    expect(decodeDataURL("https://example.com/image.png")).toBeNull();
    expect(decodeDataURL("/api/files/abc")).toBeNull();
    expect(decodeDataURL("not-a-url")).toBeNull();
  });
});
