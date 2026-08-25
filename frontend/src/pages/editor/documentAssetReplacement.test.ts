import { describe, expect, it, vi } from "vitest";
import { applyDocumentAssetReplacement } from "./documentAssetReplacement";

describe("document asset replacement", () => {
  it("patches only the Markdown widget reference through the scene capability", async () => {
    const scene = {
      summaryById: vi.fn(() => ({
        ok: true as const,
        value: {
          id: "widget",
          type: "embeddable",
          link: "excalidash://asset-widget",
          customData: {
            foreign: { kept: true },
            excalidash: {
              schemaVersion: 2,
              widget: { kind: "markdown", assetId: "old" },
            },
          },
        },
      })),
      applySettled: vi.fn(async () => ({ ok: true as const, value: undefined })),
    } as any;

    expect(
      await applyDocumentAssetReplacement(
        scene,
        {
          drawingId: "board",
          elementId: "widget",
          previousAssetId: "old",
          assetId: "new",
          drawingVersion: 2,
          element: { id: "widget" },
        },
        "never",
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(scene.applySettled).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          kind: "patch",
          id: "widget",
          changes: {
            customData: {
              foreign: { kept: true },
              excalidash: {
                schemaVersion: 2,
                widget: { kind: "markdown", assetId: "new" },
              },
            },
          },
        }),
      ],
      { capture: "never" },
    );
  });
});
