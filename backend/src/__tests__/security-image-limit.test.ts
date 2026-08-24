import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSecuritySettings, resetSecuritySettings, sanitizeDrawingData } from "../security";

const IMAGE_DATA_URL_TOO_LARGE = "IMAGE_DATA_URL_TOO_LARGE";
const dataUrlWithLength = (length: number): string => {
  const prefix = "data:image/png;base64,";
  if (length < prefix.length) throw new Error("test limit is shorter than the data URL prefix");
  return prefix + "A".repeat(length - prefix.length);
};

const drawingWithDataUrl = (dataURL: string) => ({
  elements: [],
  appState: {},
  files: {
    image: {
      id: "image",
      mimeType: "image/png",
      dataURL,
    },
  },
});

describe("image data URL storage limit", () => {
  beforeEach(() => resetSecuritySettings());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["one byte below", 99],
    ["exactly at", 100],
  ])("preserves a payload %s the configured limit byte-for-byte", (_label, length) => {
    configureSecuritySettings({ maxDataUrlSize: 100 });
    const dataURL = dataUrlWithLength(length);
    const input = drawingWithDataUrl(dataURL);

    expect(Buffer.byteLength(dataURL, "utf8")).toBe(length);

    const result = sanitizeDrawingData(input);

    expect(result.files.image.dataURL).toBe(dataURL);
    expect(input.files.image.dataURL).toBe(dataURL);
  });

  it("rejects the whole payload one byte above the configured limit", () => {
    configureSecuritySettings({ maxDataUrlSize: 100 });
    const secretSentinel = "SECRET_SENTINEL";
    const dataURL = dataUrlWithLength(101);
    const input = drawingWithDataUrl(dataURL);
    (input.files.image as Record<string, unknown>).encryptionKey = secretSentinel;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(Buffer.byteLength(dataURL, "utf8")).toBe(101);

    let caught: unknown;
    try {
      sanitizeDrawingData(input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: IMAGE_DATA_URL_TOO_LARGE,
      message: "Image data URL exceeds the configured storage limit.",
      maxBytes: 100,
    });
    expect(input.files.image.dataURL).toBe(dataURL);
    const logged = JSON.stringify(stderrWrite.mock.calls);
    expect(logged).not.toContain(secretSentinel);
  });

  it("measures non-base64 multibyte data URLs in UTF-8 bytes", () => {
    configureSecuritySettings({ maxDataUrlSize: 100 });
    const oneByteBelow = "data:image/png," + "中".repeat(28);
    const exactlyAt = oneByteBelow + "A";
    const oneByteAbove = exactlyAt + "A";

    expect(Buffer.byteLength(oneByteBelow, "utf8")).toBe(99);
    expect(Buffer.byteLength(exactlyAt, "utf8")).toBe(100);
    expect(Buffer.byteLength(oneByteAbove, "utf8")).toBe(101);

    expect(sanitizeDrawingData(drawingWithDataUrl(oneByteBelow)).files.image.dataURL).toBe(
      oneByteBelow,
    );
    expect(sanitizeDrawingData(drawingWithDataUrl(exactlyAt)).files.image.dataURL).toBe(exactlyAt);
    expect(() => sanitizeDrawingData(drawingWithDataUrl(oneByteAbove))).toThrow(
      expect.objectContaining({
        code: IMAGE_DATA_URL_TOO_LARGE,
        maxBytes: 100,
      }),
    );
  });
});
