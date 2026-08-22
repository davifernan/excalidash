import { describe, expect, it, vi } from "vitest";
import {
  createDocumentPageManager,
  DOCUMENT_PAGE_EVENT,
  DOCUMENT_PAGE_LIMITS,
  parseDocumentPageCommand,
  registerDocumentPageRoomEvent,
} from "./socketDocumentPages";

const command = (overrides: Record<string, unknown> = {}) => ({
  drawingId: "board-1",
  elementId: "widget-1",
  assetId: "asset-1",
  page: 3,
  ...overrides,
});

describe("what the server accepts as a page turn", () => {
  it("takes a well-formed command", () => {
    expect(parseDocumentPageCommand(command({ assetId: undefined }))).toEqual({
      drawingId: "board-1",
      elementId: "widget-1",
      page: 3,
    });
  });

  it("does not take an asset binding from the client", () => {
    expect(parseDocumentPageCommand(command({ assetId: "forged-asset" }))).toEqual({
      drawingId: "board-1",
      elementId: "widget-1",
      page: 3,
    });
  });

  it.each([
    ["no page below one", { page: 0 }],
    ["no fractional page", { page: 1.5 }],
    ["no page as text", { page: "3" }],
    ["no page outside the database integer range", { page: DOCUMENT_PAGE_LIMITS.maxPage + 1 }],
    ["no path in an element id", { elementId: "../../etc/passwd" }],
    ["no oversized element id", { elementId: "x".repeat(65) }],
    ["no missing board", { drawingId: undefined }],
  ])("%s", (_name, overrides) => {
    expect(parseDocumentPageCommand(command(overrides))).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(parseDocumentPageCommand("board-1")).toBeNull();
    expect(parseDocumentPageCommand([command()])).toBeNull();
    expect(parseDocumentPageCommand(null)).toBeNull();
  });
});

type Row = {
  drawingId: string;
  elementId: string;
  assetId: string;
  page: number;
  revision: number;
};

const row = (overrides: Partial<Row> = {}): Row => ({
  drawingId: "board-1",
  elementId: "widget-1",
  assetId: "asset-1",
  page: 1,
  revision: 0,
  ...overrides,
});

const fakePrisma = ({
  asset,
  rows = [],
}: {
  asset: { pageCount: number | null; status: string } | null;
  rows?: Row[];
}) => {
  const stored = [...rows];
  const fake: any = {
    stored,
    drawingAsset: {
      findMany: vi.fn(async ({ where }: any) =>
        asset
          ? [
              ...new Set(
                stored
                  .filter((item) => item.drawingId === where.drawingId)
                  .map((item) => item.assetId),
              ),
            ].map((assetId) => ({ drawingId: where.drawingId, assetId, state: "ACTIVE" }))
          : [],
      ),
    },
    drawing: {
      findUnique: vi.fn(async ({ where }: any) => ({
        elements: JSON.stringify(
          stored
            .filter((item) => item.drawingId === where.id)
            .map((item) => ({
              id: item.elementId,
              type: "embeddable",
              link: "excalidash://asset-widget",
              customData: { schemaVersion: 1, widgetKind: "pdf", assetId: item.assetId },
            })),
        ),
      })),
    },
    documentPageView: {
      // Real Prisma honours `select`, so the fake has to as well: a test that
      // accepts a shape production never returns proves nothing.
      findMany: vi.fn(async ({ where, select }: any) =>
        stored
          .filter((row) => row.drawingId === where.drawingId)
          .map((row) =>
            Object.fromEntries(Object.keys(select).map((key) => [key, (row as any)[key]])),
          ),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.drawingId_elementId;
        const found = stored.find(
          (item) => item.drawingId === key.drawingId && item.elementId === key.elementId,
        );
        return found && asset ? { ...found, asset } : null;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = stored.length;
        const keep = new Set(where.elementId?.notIn ?? []);
        for (let index = stored.length - 1; index >= 0; index -= 1) {
          if (stored[index].drawingId === where.drawingId && !keep.has(stored[index].elementId)) {
            stored.splice(index, 1);
          }
        }
        return { count: before - stored.length };
      }),
      create: vi.fn(async ({ data }: any) => {
        stored.push(data);
        return data;
      }),
      update: vi.fn(async ({ where, data, select }: any) => {
        const key = where.drawingId_elementId;
        const found = stored.find(
          (r) => r.drawingId === key.drawingId && r.elementId === key.elementId,
        );
        if (!found) throw new Error("missing page row");
        if (data.page !== undefined) found.page = data.page;
        if (typeof data.assetId === "string") found.assetId = data.assetId;
        if (data.revision?.increment) found.revision += data.revision.increment;
        return Object.fromEntries(Object.keys(select).map((key) => [key, (found as any)[key]]));
      }),
    },
  };
  fake.$transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => work(fake));
  return fake;
};

const fakeIo = () => {
  const emit = vi.fn();
  return { emit, to: vi.fn(() => ({ emit })) };
};

describe("the room's shared page", () => {
  it("records the turn and tells the room", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: 12, status: "READY" },
      rows: [row()],
    });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await pages.set(command() as any);

    expect(io.to).toHaveBeenCalledWith("drawing_board-1");
    expect(io.emit).toHaveBeenCalledWith(DOCUMENT_PAGE_EVENT, {
      drawingId: "board-1",
      pages: [{ elementId: "widget-1", assetId: "asset-1", page: 3, revision: 1 }],
    });
    expect(prisma.stored).toEqual([row({ page: 3, revision: 1 })]);
    expect(prisma.drawing.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an invented element even when the named asset is attached", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: 12, status: "READY" },
      rows: [row()],
    });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await expect(pages.set(command({ elementId: "invented-widget" }) as any)).resolves.toEqual({
      error: {
        code: "document-widget-not-found",
        message: "Document widget is not part of this board",
      },
    });

    expect(io.emit).not.toHaveBeenCalled();
    expect(prisma.stored).toEqual([row()]);
  });

  it("orders concurrent turns with a monotonic per-widget revision", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: 12, status: "READY" },
      rows: [row()],
    });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await Promise.all([
      pages.set(command({ page: 4 }) as any),
      pages.set(command({ page: 5 }) as any),
    ]);

    expect(io.emit.mock.calls.map(([, update]) => update.pages[0].revision).sort()).toEqual([1, 2]);
  });

  it("refuses a page the document does not have", async () => {
    const prisma = fakePrisma({ asset: { pageCount: 2, status: "READY" }, rows: [row()] });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await pages.set(command({ page: 3 }) as any);

    expect(io.emit).not.toHaveBeenCalled();
    expect(prisma.stored).toEqual([row()]);
  });

  it("refuses a document that is not on this board", async () => {
    const prisma = fakePrisma({ asset: null });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await pages.set(command() as any);

    expect(io.emit).not.toHaveBeenCalled();
    expect(prisma.stored).toEqual([]);
  });

  it("refuses a document that is not ready to be read", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: 9, status: "REJECTED" },
      rows: [row()],
    });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await pages.set(command() as any);

    expect(io.emit).not.toHaveBeenCalled();
  });

  it("refuses a document whose page count has not been derived", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: null, status: "READY" },
      rows: [row()],
    });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await expect(pages.set(command({ page: 250 }) as any)).resolves.toMatchObject({
      error: { code: "document-page-count-unavailable" },
    });

    expect(prisma.stored[0].page).toBe(1);
  });

  it("uses a derived page count for an older text asset", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: null, status: "READY" },
      rows: [row()],
    });
    const io = fakeIo();
    const resolvePageCount = vi.fn(async () => 2);
    const pages = createDocumentPageManager({ io: io as any, prisma, resolvePageCount });

    await pages.set(command({ page: 2 }) as any);
    await expect(pages.set(command({ page: 3 }) as any)).resolves.toMatchObject({
      error: { code: "document-page-out-of-range" },
    });

    expect(resolvePageCount).toHaveBeenCalledWith("asset-1");
    expect(prisma.stored[0]).toMatchObject({ page: 2, revision: 1 });
  });

  it("stays quiet when the page did not actually change", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: 12, status: "READY" },
      rows: [row({ page: 3 })],
    });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await pages.set(command({ page: 3 }) as any);

    expect(io.emit).not.toHaveBeenCalled();
    expect(prisma.documentPageView.update).not.toHaveBeenCalled();
  });

  it("stops a board from tracking endless invented widgets", async () => {
    const rows = Array.from({ length: DOCUMENT_PAGE_LIMITS.widgetsPerDrawing }, (_, i) => ({
      drawingId: "board-1",
      elementId: `widget-${i}`,
      assetId: "asset-1",
      page: 1,
      revision: 0,
    }));
    const prisma = fakePrisma({ asset: { pageCount: 12, status: "READY" }, rows });
    const io = fakeIo();
    const pages = createDocumentPageManager({ io: io as any, prisma });

    await pages.set(command({ elementId: "one-too-many" }) as any);

    expect(io.emit).not.toHaveBeenCalled();
    expect(prisma.stored).toHaveLength(DOCUMENT_PAGE_LIMITS.widgetsPerDrawing);

    // An id that is already tracked still moves, so a full board is not frozen.
    await pages.set(command({ elementId: "widget-0", page: 7 }) as any);
    expect(io.emit).toHaveBeenCalled();
  });

  it("hands a joiner every page the room is on", async () => {
    const prisma = fakePrisma({
      asset: { pageCount: 12, status: "READY" },
      rows: [
        row({ page: 4, revision: 8 }),
        row({ drawingId: "other", elementId: "widget-9", assetId: "asset-2", page: 2 }),
      ],
    });
    const pages = createDocumentPageManager({ io: fakeIo() as any, prisma });

    expect(await pages.snapshot("board-1")).toEqual({
      drawingId: "board-1",
      pages: [{ elementId: "widget-1", assetId: "asset-1", page: 4, revision: 8 }],
    });
  });
});

describe("page-turn acknowledgements", () => {
  it("returns the semantic refusal code from the page manager", async () => {
    let listener: ((value: unknown, ack: (value: unknown) => void) => Promise<void>) | undefined;
    const socket = {
      on: vi.fn((_event: string, handler: typeof listener) => {
        listener = handler;
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    const error = {
      code: "document-widget-not-found",
      message: "Document widget is not part of this board",
    };
    registerDocumentPageRoomEvent({
      socket: socket as any,
      pages: { set: vi.fn(async () => ({ error })), snapshot: vi.fn() } as any,
      requireAccess: vi.fn(async () => true),
    });
    const ack = vi.fn();

    await listener?.(command(), ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, error });
  });
});
