import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockToast, mockUploadDocumentAsset } = vi.hoisted(() => ({
  mockToast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
  mockUploadDocumentAsset: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY" },
  convertToExcalidrawElements: (elements: unknown[]) => elements,
}));
vi.mock("../../api", () => ({
  isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  uploadDocumentAsset: mockUploadDocumentAsset,
}));

import {
  addDroppedDocumentWidgets,
  addDroppedPdfWidgets,
  getDocumentDropFiles,
} from "./documentDrop";

const axiosError = (status: number, message?: string) => ({
  isAxiosError: true,
  response: { status, data: message ? { message } : {} },
});

describe("PDF drop errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [413, "File exceeds the 30 MB upload limit.", "The file is too large (max 30 MB)."],
    [507, "Storage limit reached", "No storage space is available."],
    [
      422,
      "The PDF has a damaged cross-reference table.",
      "The PDF has a damaged cross-reference table.",
    ],
    [403, "Read-only access", "You can view this board, but you cannot add anything to it."],
  ])("shows a useful message for HTTP %i", async (status, serverMessage, expected) => {
    mockUploadDocumentAsset.mockRejectedValueOnce(axiosError(status, serverMessage));
    const apply = vi.fn();
    await addDroppedPdfWidgets({
      drawingId: "drawing-1",
      files: [new File(["pdf"], "brief.pdf", { type: "application/pdf" })],
      point: { x: 100, y: 200 },
      scene: { apply } as any,
    });

    expect(mockToast.error).toHaveBeenCalledWith(expected, {
      id: expect.stringMatching(/^document-upload-/),
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("creates a Markdown widget for a dropped .md file", async () => {
    mockUploadDocumentAsset.mockResolvedValueOnce({ id: "asset-md", kind: "MARKDOWN" });
    const apply = vi.fn(() => ({ ok: true, value: undefined }));
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });

    await addDroppedDocumentWidgets({
      drawingId: "drawing-1",
      files: [file],
      point: { x: 100, y: 200 },
      scene: { apply } as any,
    });

    expect(mockUploadDocumentAsset).toHaveBeenCalledWith(
      "drawing-1",
      file,
      "markdown",
      expect.any(Function),
    );
    expect(apply.mock.calls[0][0][0].elements[0]).toMatchObject({
      type: "embeddable",
      customData: {
        excalidash: { schemaVersion: 2, widget: { kind: "markdown", assetId: "asset-md" } },
      },
    });
    expect(apply.mock.calls[0][0][1]).toEqual({
      kind: "select",
      ids: [expect.any(String)],
    });
    expect(apply).toHaveBeenCalledWith(expect.any(Array), { capture: "immediate" });
  });

  it("rejects when the atomic scene write reports a capability failure", async () => {
    mockUploadDocumentAsset.mockResolvedValueOnce({ id: "asset-pdf", kind: "PDF" });

    await expect(
      addDroppedDocumentWidgets({
        drawingId: "drawing-1",
        files: [new File(["pdf"], "brief.pdf", { type: "application/pdf" })],
        point: { x: 100, y: 200 },
        scene: {
          apply: vi.fn(() => ({
            ok: false,
            code: "editor-changed",
            seam: "scene.apply",
          })),
        } as any,
      } as any),
    ).rejects.toThrow("scene.apply failed (editor-changed)");
  });

  it("leaves a drop containing any unrelated file to Excalidraw", () => {
    const markdown = new File(["# Notes"], "notes.markdown");
    const unrelated = new File(["data"], "photo.png", { type: "image/png" });

    expect(getDocumentDropFiles([markdown])).toEqual([markdown]);
    expect(getDocumentDropFiles([markdown, unrelated])).toBeNull();
    expect(getDocumentDropFiles([unrelated])).toBeNull();
  });
});
