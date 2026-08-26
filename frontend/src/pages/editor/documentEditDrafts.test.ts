import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_EDIT_DRAFT_COMMAND_EVENT,
  bindSocketDocumentEditDrafts,
  createDocumentEditDraftPublisher,
  createTextPatch,
} from "./documentEditDrafts";
import { LIVE_TEXT_SEND_INTERVAL_MS } from "./trailingPublisher";

const apply = (content: string, patch: { start: number; deleteCount: number; text: string }) =>
  `${content.slice(0, patch.start)}${patch.text}${content.slice(patch.start + patch.deleteCount)}`;

describe("Markdown live drafts", () => {
  it("builds a minimal replacement span", () => {
    expect(createTextPatch("# Original notes", "# Live notes")).toEqual({
      start: 2,
      deleteCount: 8,
      text: "Live",
    });
  });

  it("reuses the shared 150ms publisher, sends at most seven states per second, and keeps the tail", () => {
    vi.useFakeTimers();
    const emitted: any[] = [];
    const socket = {
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
    } as any;
    const publisher = createDocumentEditDraftPublisher({
      socket,
      drawingId: "drawing-1",
      assetId: "asset-1",
      token: "lock-token",
      content: "initial",
    });

    for (let index = 1; index <= 100; index += 1) publisher.update(`draft ${index}`);
    vi.advanceTimersByTime(1_000);

    const patches = emitted.filter(({ event }) => event === DOCUMENT_EDIT_DRAFT_COMMAND_EVENT);
    expect(LIVE_TEXT_SEND_INTERVAL_MS).toBe(150);
    expect(patches).toHaveLength(2);
    let reconstructed = "";
    for (const { payload } of patches) reconstructed = apply(reconstructed, payload);
    expect(reconstructed).toBe("draft 100");

    publisher.cancel();
    expect(emitted.at(-1)?.payload.action).toBe("clear");
    vi.useRealTimers();
  });

  it("applies snapshots and ordered patches, then rolls back on clear", () => {
    const handlers = new Map<string, (payload: any) => void>();
    const socket = {
      on: (event: string, handler: (payload: any) => void) => handlers.set(event, handler),
      off: vi.fn(),
    } as any;
    let drafts: any = {};
    bindSocketDocumentEditDrafts({
      socket,
      drawingId: "drawing-1",
      onChange: (update) => {
        drafts = update(drafts);
      },
    });
    const receive = handlers.get("document-edit-draft-update")!;

    receive({
      drawingId: "drawing-1",
      drafts: [{ assetId: "asset-1", presenceId: "writer", revision: 1, content: "# Live" }],
    });
    receive({
      drawingId: "drawing-1",
      assetId: "asset-1",
      presenceId: "writer",
      revision: 2,
      patch: { start: 6, deleteCount: 0, text: " now" },
    });
    expect(drafts["asset-1"].content).toBe("# Live now");

    receive({ drawingId: "drawing-1", assetId: "asset-1", content: null });
    expect(drafts).toEqual({});
  });
});
