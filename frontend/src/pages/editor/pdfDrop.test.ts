import { beforeEach, describe, expect, it, vi } from "vitest";

const { notification, mockUploadDocumentAsset } = vi.hoisted(() => ({
  notification: vi.fn(() => "notification-id"),
  mockUploadDocumentAsset: vi.fn(),
}));

vi.mock("../../notifications", () => ({ notify: notification }));
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

    expect(notification).toHaveBeenCalledWith("error", expected, {
      key: expect.stringMatching(/^document-upload-/),
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

describe("the element that reaches the scene", () => {
  /**
   * The bookkeeping is the point. `reconcileElements` decides a collaborative
   * merge on version, versionNonce, seed and friends -- a widget inserted
   * without them risks being overwritten by an older copy of itself. The first
   * version of `asWidgetElement` listed seven fields and dropped the rest.
   */
  it("carries the fields the merge reconciles on, not just the seven it names", async () => {
    const { asWidgetElement } = await import("./documentDrop");
    const built = {
      id: "w1",
      type: "embeddable",
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      link: "excalidash://pdf/a1",
      angle: 0.5,
      seed: 12345,
      version: 7,
      versionNonce: 99,
      groupIds: ["g1"],
      roundness: { type: 3 },
      fillStyle: "solid",
      roughness: 0,
    };

    const element = asWidgetElement(built) as unknown as Record<string, unknown>;

    for (const key of [
      "angle",
      "seed",
      "version",
      "versionNonce",
      "groupIds",
      "roundness",
      "fillStyle",
      "roughness",
    ]) {
      expect(element).toHaveProperty(key);
    }
    // Still the fields the contract names, unchanged.
    expect(element.type).toBe("embeddable");
    expect(element.link).toBe("excalidash://pdf/a1");
  });
});
