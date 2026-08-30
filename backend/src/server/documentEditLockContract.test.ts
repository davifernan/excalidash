import { describe, expect, it } from "vitest";
import {
  DOCUMENT_EDIT_LOCK_COMMAND_EVENT as DOMAIN_COMMAND_EVENT,
  DOCUMENT_EDIT_LOCK_EVENT as DOMAIN_UPDATE_EVENT,
  DOCUMENT_EDIT_LOCK_GRANTED_EVENT as DOMAIN_GRANTED_EVENT,
} from "@excalidash/domain/collaboration";
import {
  DOCUMENT_EDIT_LOCK_COMMAND_EVENT,
  DOCUMENT_EDIT_LOCK_EVENT,
  DOCUMENT_EDIT_LOCK_GRANTED_EVENT,
  documentEditLockSnapshot,
} from "./socketDocumentEditLocks";
import { DocumentEditLockRegistry } from "./documentEditLocks";
import {
  bindSocketDocumentEditLocks,
  DOCUMENT_EDIT_LOCK_COMMAND_EVENT as FRONTEND_COMMAND_EVENT,
} from "../../../frontend/src/pages/editor/documentEditLocks";

/**
 * Cross-runtime behavioral proof for document edit locks' wire contract
 * (NIL-637, Zweig B, collaboration sockets domain).
 *
 * Both sides now import the three event names and the client-facing
 * PublicDocumentEditLock shape from @excalidash/domain/collaboration
 * instead of independently declaring them. This drives the real registry
 * (server truth) and the real frontend parser/binder against each other,
 * rather than asserting the shared constants exist and stopping there --
 * the point is that a snapshot the server actually produces is one the
 * frontend actually accepts, and that server-only fields (token,
 * drawingId on the per-lock entry) never appear in it.
 */

describe("document edit lock wire contract", () => {
  it("all three re-exported event names are the identical domain binding, not a re-declared copy", () => {
    expect(DOCUMENT_EDIT_LOCK_COMMAND_EVENT).toBe(DOMAIN_COMMAND_EVENT);
    expect(DOCUMENT_EDIT_LOCK_EVENT).toBe(DOMAIN_UPDATE_EVENT);
    expect(DOCUMENT_EDIT_LOCK_GRANTED_EVENT).toBe(DOMAIN_GRANTED_EVENT);
    expect(FRONTEND_COMMAND_EVENT).toBe(DOMAIN_COMMAND_EVENT);
  });

  it("a real snapshot from the server registry is accepted by the real frontend parser, with no server-only field leaking", () => {
    const registry = new DocumentEditLockRegistry();
    const drawingId = "drawing-1";
    const acquired = registry.acquire({
      drawingId,
      assetId: "asset-1",
      presenceId: "presence-1",
      ownerName: "Davi",
    });
    expect(acquired.ok).toBe(true);

    const snapshot = documentEditLockSnapshot(registry, drawingId);

    // The server's own envelope must never carry the capability token or
    // (per lock entry) a second copy of drawingId -- both are exactly the
    // "authority stays on the server" fields this domain's standing rule
    // names.
    for (const lock of snapshot.locks) {
      expect(lock).not.toHaveProperty("token");
      expect(lock).not.toHaveProperty("drawingId");
      expect(Object.keys(lock).sort()).toEqual(["assetId", "ownerName", "presenceId"]);
    }

    const handlers = new Map<string, (payload: unknown) => void>();
    const socket = {
      on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
      off: () => {},
    };
    let received: Record<string, { assetId: string; presenceId: string; ownerName: string }> = {};
    bindSocketDocumentEditLocks({
      socket: socket as never,
      drawingId,
      onChange: (locks) => {
        received = locks;
      },
    });

    handlers.get(DOCUMENT_EDIT_LOCK_EVENT)?.(snapshot);

    expect(received["asset-1"]).toEqual({
      assetId: "asset-1",
      presenceId: "presence-1",
      ownerName: "Davi",
    });
  });
});
