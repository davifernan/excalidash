import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  MOCK_DRAWING_ID,
  MOCK_SNAPSHOT_ID,
  buildApp,
  mockDrawing,
  mockSnapshot,
} from "./drawingHistoryTestHarness";

describe("drawing history restore coordination", () => {
  it("broadcasts the committed restore to every open editor", async () => {
    const { app, prisma, io, emit } = buildApp();
    prisma.drawing.findUnique.mockResolvedValue(mockDrawing);
    prisma.drawing.findFirst.mockResolvedValue(mockDrawing);
    prisma.drawingSnapshot.findFirst.mockResolvedValue(mockSnapshot);
    prisma.drawing.update.mockResolvedValue({ ...mockDrawing, version: 6 });

    const res = await request(app).post(
      `/drawings/${MOCK_DRAWING_ID}/history/${MOCK_SNAPSHOT_ID}/restore`,
    );

    expect(res.status).toBe(200);
    expect(io.to).toHaveBeenCalledWith(`drawing_${MOCK_DRAWING_ID}`);
    expect(emit).toHaveBeenCalledWith("drawing-server-update", { drawingId: MOCK_DRAWING_ID });
  });

  it("restores document links and preserves current links in the backup", async () => {
    const { app, prisma } = buildApp();
    const archivedAssetId = "asset-from-pdf-snapshot";
    const currentAssetId = "asset-on-current-board";
    const pdfSnapshot = {
      ...mockSnapshot,
      elements: JSON.stringify([
        {
          id: "pdf-widget",
          type: "embeddable",
          link: "excalidash://asset-widget",
          customData: {
            excalidash: { schemaVersion: 2, widget: { kind: "pdf", assetId: archivedAssetId } },
          },
        },
      ]),
    };
    prisma.drawing.findUnique.mockResolvedValue(mockDrawing);
    prisma.drawing.findFirst.mockResolvedValue(mockDrawing);
    prisma.drawingSnapshot.findFirst.mockResolvedValue(pdfSnapshot);
    prisma.drawingSnapshotAsset.findMany.mockResolvedValue([{ assetId: archivedAssetId }]);
    prisma.drawingAsset.findMany
      .mockResolvedValueOnce([{ assetId: currentAssetId }])
      .mockResolvedValueOnce([
        { assetId: currentAssetId, state: "ACTIVE" },
        { assetId: archivedAssetId, state: "ACTIVE" },
      ]);
    prisma.drawing.update.mockResolvedValue({
      ...mockDrawing,
      elements: pdfSnapshot.elements,
      version: 6,
    });

    const res = await request(app).post(
      `/drawings/${MOCK_DRAWING_ID}/history/${MOCK_SNAPSHOT_ID}/restore`,
    );

    expect(res.status).toBe(200);
    expect(prisma.drawingSnapshotAsset.create).toHaveBeenCalledWith({
      data: { snapshotId: "backup-snapshot", assetId: currentAssetId },
    });
    expect(prisma.drawingAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          drawingId_assetId: { drawingId: MOCK_DRAWING_ID, assetId: archivedAssetId },
        },
      }),
    );
    expect(prisma.drawingAsset.delete).toHaveBeenCalledWith({
      where: { drawingId_assetId: { drawingId: MOCK_DRAWING_ID, assetId: currentAssetId } },
    });
  });
});
