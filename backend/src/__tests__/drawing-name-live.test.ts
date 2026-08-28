import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { buildApp, MOCK_DRAWING_ID, mockDrawing } from "./drawingHistoryTestHarness";

const renamedDrawing = { ...mockDrawing, name: "Live roadmap", nameRevision: 2 };

describe("live drawing name updates", () => {
  it("broadcasts the persisted name after an authorized HTTP rename", async () => {
    const { app, prisma, io, emit, drawingUpdateSchema } = buildApp();
    prisma.drawing.findUnique.mockResolvedValue(mockDrawing);
    prisma.drawing.findFirst.mockResolvedValue(renamedDrawing);
    prisma.drawing.updateMany.mockResolvedValue({ count: 1 });
    drawingUpdateSchema.safeParse.mockReturnValue({
      success: true,
      data: { name: renamedDrawing.name },
    });

    const response = await request(app)
      .put(`/drawings/${MOCK_DRAWING_ID}`)
      .send({ name: renamedDrawing.name });

    expect(response.status).toBe(200);
    expect(io.to).toHaveBeenCalledWith(`drawing_${MOCK_DRAWING_ID}`);
    expect(emit).toHaveBeenCalledWith("drawing-name-update", {
      drawingId: MOCK_DRAWING_ID,
      name: renamedDrawing.name,
      revision: renamedDrawing.nameRevision,
    });
    expect(prisma.drawing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nameRevision: { increment: 1 } }),
      }),
    );
  });

  it("does not publish a name a read-only user was forbidden to save", async () => {
    const { app, prisma, io, drawingUpdateSchema } = buildApp({ userId: "viewer-1" });
    prisma.drawing.findUnique.mockResolvedValue(mockDrawing);
    prisma.drawing.findMany.mockResolvedValue([mockDrawing]);
    prisma.drawingPermission.findUnique.mockResolvedValue({ permission: "view" });
    prisma.drawingPermission.findMany.mockResolvedValue([
      { drawingId: MOCK_DRAWING_ID, permission: "view" },
    ]);
    drawingUpdateSchema.safeParse.mockReturnValue({
      success: true,
      data: { name: renamedDrawing.name },
    });

    const response = await request(app)
      .put(`/drawings/${MOCK_DRAWING_ID}`)
      .send({ name: renamedDrawing.name });

    expect(response.status).toBe(404);
    expect(prisma.drawing.updateMany).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  it("keeps the committed HTTP result successful when live distribution fails", async () => {
    const { app, prisma, emit, drawingUpdateSchema } = buildApp();
    prisma.drawing.findUnique.mockResolvedValue(mockDrawing);
    prisma.drawing.findFirst.mockResolvedValue(renamedDrawing);
    prisma.drawing.updateMany.mockResolvedValue({ count: 1 });
    drawingUpdateSchema.safeParse.mockReturnValue({
      success: true,
      data: { name: renamedDrawing.name },
    });
    emit.mockImplementationOnce(() => {
      throw new Error("socket transport unavailable");
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const response = await request(app)
        .put(`/drawings/${MOCK_DRAWING_ID}`)
        .send({ name: renamedDrawing.name });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe(renamedDrawing.name);
      const logged = stderrWrite.mock.calls.map((call) => JSON.parse(call[0] as string));
      expect(logged).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "Drawing name broadcast failed after persistence",
          drawingId: MOCK_DRAWING_ID,
          error: expect.objectContaining({ message: "socket transport unavailable" }),
        }),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
