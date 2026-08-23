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
    await addDroppedPdfWidgets({
      canvasApi: {
        getSceneElementsIncludingDeleted: () => [],
        updateScene: vi.fn(),
      },
      drawingId: "drawing-1",
      files: [new File(["pdf"], "brief.pdf", { type: "application/pdf" })],
      point: { x: 100, y: 200 },
    });

    expect(mockToast.error).toHaveBeenCalledWith(expected, {
      id: expect.stringMatching(/^document-upload-/),
    });
  });

  it("creates a Markdown widget for a dropped .md file", async () => {
    mockUploadDocumentAsset.mockResolvedValueOnce({ id: "asset-md", kind: "MARKDOWN" });
    const updateScene = vi.fn();
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });

    await addDroppedDocumentWidgets({
      canvasApi: { getSceneElementsIncludingDeleted: () => [], updateScene },
      drawingId: "drawing-1",
      files: [file],
      point: { x: 100, y: 200 },
    });

    expect(mockUploadDocumentAsset).toHaveBeenCalledWith(
      "drawing-1",
      file,
      "markdown",
      expect.any(Function),
    );
    expect(updateScene.mock.calls[0][0].elements[0]).toMatchObject({
      type: "embeddable",
      customData: {
        excalidash: { schemaVersion: 2, widget: { kind: "markdown", assetId: "asset-md" } },
      },
    });
  });

  it("leaves a drop containing any unrelated file to Excalidraw", () => {
    const markdown = new File(["# Notes"], "notes.markdown");
    const unrelated = new File(["data"], "photo.png", { type: "image/png" });

    expect(getDocumentDropFiles([markdown])).toEqual([markdown]);
    expect(getDocumentDropFiles([markdown, unrelated])).toBeNull();
    expect(getDocumentDropFiles([unrelated])).toBeNull();
  });
});
