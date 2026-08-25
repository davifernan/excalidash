import { describe, expect, it, vi } from "vitest";
import { applyDocumentAssetReplacement } from "./documentAssetReplacement";

describe("document asset replacement", () => {
  it("patches every Markdown widget sharing the replaced asset", async () => {
    const scene = {
      summaryById: vi.fn((id: string) => ({
        ok: true as const,
        value: {
          id,
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
          previousAssetId: "old",
          assetId: "new",
          drawingVersion: 2,
          elements: [{ id: "widget" }, { id: "widget-copy" }],
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
        expect.objectContaining({
          kind: "patch",
          id: "widget-copy",
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
