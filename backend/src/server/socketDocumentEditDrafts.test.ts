import { describe, expect, it, vi } from "vitest";
import { DocumentEditLockRegistry } from "./documentEditLocks";
import {
  DOCUMENT_EDIT_DRAFT_COMMAND_EVENT,
  DOCUMENT_EDIT_DRAFT_EVENT,
  documentEditDraftSnapshot,
  parseDocumentEditDraftCommand,
  registerDocumentEditDraftRoomEvent,
} from "./socketDocumentEditDrafts";

describe("Markdown live draft socket", () => {
  const drawingId = "11111111-2222-3333-4444-555555555555";
  const assetId = "markdown-asset";

  const setup = () => {
    const handlers = new Map<string, (value: unknown) => Promise<void> | void>();
    const emitted: Array<{ event: string; payload: any }> = [];
    const senderEvents: Array<{ event: string; payload: any }> = [];
    const socket = {
      id: "writer-socket",
      on: (event: string, handler: any) => handlers.set(event, handler),
      emit: (event: string, payload: any) => senderEvents.push({ event, payload }),
      to: () => ({
        emit: (event: string, payload: any) => emitted.push({ event, payload }),
      }),
      disconnect: vi.fn(),
    } as any;
    const locks = new DocumentEditLockRegistry();
    const acquired = locks.acquire({
      drawingId,
      assetId,
      presenceId: socket.id,
      ownerName: "Alice",
    });
    if (!acquired.ok) throw new Error("lock missing");
    const requireAccess = vi.fn(async () => true);
    registerDocumentEditDraftRoomEvent({ socket, locks, requireAccess });
    return {
      handlers,
      emitted,
      senderEvents,
      locks,
      requireAccess,
      token: acquired.lock.token,
    };
  };

  it("relays ordered patches from the lock owner and exposes a late-join snapshot", async () => {
    const { handlers, emitted, locks, token } = setup();
    const send = handlers.get(DOCUMENT_EDIT_DRAFT_COMMAND_EVENT)!;

    await send({
      drawingId,
      assetId,
      token,
      action: "patch",
      revision: 1,
      start: 0,
      deleteCount: 0,
      text: "# Original",
    });
    await send({
      drawingId,
      assetId,
      token,
      action: "patch",
      revision: 2,
      start: 2,
      deleteCount: 8,
      text: "Live",
    });

    expect(emitted.map(({ event }) => event)).toEqual([
      DOCUMENT_EDIT_DRAFT_EVENT,
      DOCUMENT_EDIT_DRAFT_EVENT,
    ]);
    expect(emitted.at(-1)?.payload.patch).toEqual({ start: 2, deleteCount: 8, text: "Live" });
    expect(documentEditDraftSnapshot(locks, drawingId)).toEqual({
      drawingId,
      drafts: [
        {
          assetId,
          presenceId: "writer-socket",
          revision: 2,
          content: "# Live",
        },
      ],
    });
  });

  it("refuses a stale token and a skipped revision instead of broadcasting either", async () => {
    const { handlers, emitted, senderEvents, token } = setup();
    const send = handlers.get(DOCUMENT_EDIT_DRAFT_COMMAND_EVENT)!;
    const command = {
      drawingId,
      assetId,
      action: "patch",
      revision: 1,
      start: 0,
      deleteCount: 0,
      text: "draft",
    };

    await send({ ...command, token: "00000000-0000-4000-8000-000000000000" });
    await send({ ...command, token, revision: 2 });

    expect(emitted).toEqual([]);
    expect(senderEvents.map(({ payload }) => payload.error.code)).toEqual([
      "document-edit-draft-out-of-sync",
      "document-edit-draft-out-of-sync",
    ]);
  });

  it("clears immediately even after the ordinary per-second budget is spent", async () => {
    const { handlers, emitted, token } = setup();
    const send = handlers.get(DOCUMENT_EDIT_DRAFT_COMMAND_EVENT)!;
    for (let revision = 1; revision <= 10; revision += 1) {
      await send({
        drawingId,
        assetId,
        token,
        action: "patch",
        revision,
        start: revision === 1 ? 0 : revision - 1,
        deleteCount: 0,
        text: "x",
      });
    }
    await send({ drawingId, assetId, token, action: "clear" });

    expect(emitted.at(-1)).toEqual({
      event: DOCUMENT_EDIT_DRAFT_EVENT,
      payload: { drawingId, assetId, content: null },
    });
  });

  it("rejects malformed patch coordinates before access or broadcast", () => {
    expect(
      parseDocumentEditDraftCommand({
        drawingId,
        assetId,
        token: "00000000-0000-4000-8000-000000000000",
        action: "patch",
        revision: 1,
        start: -1,
        deleteCount: 0,
        text: "x",
      }),
    ).toBeNull();
  });
});
