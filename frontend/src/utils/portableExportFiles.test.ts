import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleDrawingFilesForExport } from "./portableExportFiles";

const fetchMock = vi.fn();

describe("bundleDrawingFilesForExport", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("replaces a stored reference with the image bytes from its authenticated route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    });

    const result = await bundleDrawingFilesForExport("drawing id", {
      image: {
        id: "image",
        mimeType: "image/png",
        dataURL: "/api/files/source/image",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/files/drawing%20id/image", {
      credentials: "same-origin",
    });
    expect(result.image.dataURL).toBe("data:image/png;base64,AQID");
  });

  it("leaves already embedded files untouched without a request", async () => {
    const files = { image: { dataURL: "data:image/png;base64,AQID" } };
    await expect(bundleDrawingFilesForExport("drawing", files)).resolves.toEqual(files);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the export instead of emitting a reference whose bytes are unavailable", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    await expect(
      bundleDrawingFilesForExport("drawing", {
        missing: { dataURL: "/api/files/source/missing", mimeType: "image/png" },
      }),
    ).rejects.toThrow("export cancelled to prevent image loss: missing");
  });
});
