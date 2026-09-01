import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import type { BoardAgentFocusEvent, BoardAgentRuntimePresenceEvent } from "../agent/presence";
import { FakeIo, room, socketJoinSnapshotPrisma } from "../__tests__/socketTestDoubles";
import { PresenceRegistry } from "./presenceRegistry";
import { registerSocketHandlers } from "./socket";
import {
  BOARD_AGENT_FOCUS_FINISHED_EVENT,
  BOARD_AGENT_FOCUS_STARTED_EVENT,
  BOARD_AGENT_PRESENCE_EVENT,
  BOARD_AGENT_RUNTIME_EVENT,
  emitBoardAgentPresenceSnapshots,
  publishBoardAgentFocus,
  publishBoardAgentRuntime,
} from "./socketPresence";
import {
  BOARD_AGENT_THREAD_EVENT_APPENDED_EVENT,
  BOARD_AGENT_THREAD_UPDATED_EVENT,
  publishBoardAgentThreadEvent,
  publishBoardAgentThreadUpdated,
} from "./socketAgentThreads";

const secret = "agent-presence-test-secret";
const tokenFor = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@example.test`, type: "access" }, secret);

describe("private Agent Presence audience", () => {
  it("delivers zero Focus, Runtime, and Presence events to a foreign board socket", async () => {
    const io = new FakeIo();
    const presences = new PresenceRegistry();
    const base = socketJoinSnapshotPrisma("owner-user");
    const prisma = {
      ...base,
      user: {
        findUnique: vi.fn(async ({ where }: any) => ({
          id: where.id,
          name: where.id === "owner-user" ? "Owner" : "Viewer",
          isActive: true,
        })),
      },
      drawing: {
        findUnique: vi.fn(async () => ({
          userId: "owner-user",
          collectionId: null,
          name: "Private focus board",
          nameRevision: 0,
          guestUploadEnabled: false,
          guestCommentVisibilityEnabled: true,
        })),
        findMany: vi.fn(async () => [
          { id: "drawing-1", userId: "owner-user", collectionId: null },
        ]),
      },
      drawingPermission: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.drawingId_granteeUserId.granteeUserId === "viewer-user"
            ? { permission: "view" }
            : null,
        ),
        findMany: vi.fn(async ({ where }: any) =>
          where.granteeUserId === "viewer-user"
            ? [{ drawingId: "drawing-1", permission: "view" }]
            : [],
        ),
      },
      collection: { findMany: vi.fn().mockResolvedValue([]) },
      collectionShare: { findMany: vi.fn().mockResolvedValue([]) },
      drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    registerSocketHandlers({
      io: io as any,
      prisma: prisma as any,
      authModeService: { getAuthEnabled: async () => true } as any,
      jwtSecret: secret,
      presences,
    });

    const owner = await io.connect("owner-socket", { token: tokenFor("owner-user") });
    const foreign = await io.connect("foreign-socket", { token: tokenFor("viewer-user") });
    await owner.trigger("join-room", { drawingId: "drawing-1", user: {} });
    await foreign.trigger("join-room", { drawingId: "drawing-1", user: {} });
    expect(owner.rooms.has(room("drawing-1"))).toBe(true);
    expect(foreign.rooms.has(room("drawing-1"))).toBe(true);
    io.emissions.length = 0;

    const common = {
      agentId: "run-private",
      runId: "run-private",
      drawingId: "drawing-1",
      revisionId: "immutable-revision-17",
      displayName: "Research",
      audience: { kind: "private", userId: "owner-user" } as const,
      occurredAt: new Date(0).toISOString(),
    };
    publishBoardAgentFocus({
      io: io as any,
      presences,
      event: {
        ...common,
        phase: "started",
        targetIds: ["frame-private"],
      } satisfies BoardAgentFocusEvent,
    });
    publishBoardAgentFocus({
      io: io as any,
      presences,
      event: {
        ...common,
        phase: "finished",
        targetIds: ["frame-private"],
      } satisfies BoardAgentFocusEvent,
    });
    publishBoardAgentRuntime({
      io: io as any,
      presences,
      event: {
        ...common,
        status: "working",
      } satisfies BoardAgentRuntimePresenceEvent,
    });
    const privateThread = {
      id: "thread-private",
      drawingId: "drawing-1",
      audience: { kind: "private", userId: "owner-user" } as const,
      title: "Local orchestrator thread",
      anchor: { kind: "private", x: 10, y: 20 } as const,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    publishBoardAgentThreadUpdated({ io: io as any, presences, thread: privateThread });
    publishBoardAgentThreadEvent({
      io: io as any,
      presences,
      thread: privateThread,
      event: {
        id: "thread-event-private",
        threadId: privateThread.id,
        sequence: 1,
        actor: { kind: "user", id: "owner-user", displayName: "Owner" },
        kind: "message",
        payload: { text: "private" },
        createdAt: new Date(0).toISOString(),
      },
    });

    const guardedEvents = new Set([
      BOARD_AGENT_FOCUS_STARTED_EVENT,
      BOARD_AGENT_FOCUS_FINISHED_EVENT,
      BOARD_AGENT_RUNTIME_EVENT,
      BOARD_AGENT_PRESENCE_EVENT,
      BOARD_AGENT_THREAD_UPDATED_EVENT,
      BOARD_AGENT_THREAD_EVENT_APPENDED_EVENT,
    ]);
    const deliveredTo = (socketId: string) =>
      io.emissions.filter(
        (emission) => emission.scope === socketId && guardedEvents.has(emission.event),
      );
    expect(deliveredTo("owner-socket").map((emission) => emission.event)).toEqual(
      expect.arrayContaining([
        BOARD_AGENT_FOCUS_STARTED_EVENT,
        BOARD_AGENT_FOCUS_FINISHED_EVENT,
        BOARD_AGENT_RUNTIME_EVENT,
        BOARD_AGENT_PRESENCE_EVENT,
        BOARD_AGENT_THREAD_UPDATED_EVENT,
        BOARD_AGENT_THREAD_EVENT_APPENDED_EVENT,
      ]),
    );
    expect(deliveredTo("foreign-socket")).toEqual([]);

    io.emissions.length = 0;
    const stale = presences.pruneStaleAgents(Date.now() + 1);
    emitBoardAgentPresenceSnapshots({
      io: io as any,
      presences,
      drawingId: "drawing-1",
      audiences: stale.map((entry) => entry.audience),
    });
    expect(deliveredTo("owner-socket").map((emission) => emission.event)).toEqual([
      BOARD_AGENT_PRESENCE_EVENT,
    ]);
    expect(deliveredTo("foreign-socket")).toEqual([]);
  });

  it("does not let a late runtime lookup overwrite a newer board status", () => {
    const io = new FakeIo();
    const presences = new PresenceRegistry();
    presences.join("drawing-1", {
      presenceId: "owner-socket",
      accountId: "owner-user",
      name: "Owner",
      initials: "OW",
      color: "#2563eb",
      kind: "owner",
      isActive: true,
      selectedElementIds: {},
      actor: "human",
    });
    const common = {
      agentId: "run-ordered",
      runId: "run-ordered",
      drawingId: "drawing-1",
      revisionId: "immutable-revision-17",
      displayName: "Research",
      audience: { kind: "drawing" } as const,
    };
    const publish = (status: BoardAgentRuntimePresenceEvent["status"], occurredAt: string) =>
      publishBoardAgentRuntime({
        io: io as any,
        presences,
        event: { ...common, status, occurredAt } satisfies BoardAgentRuntimePresenceEvent,
      });

    // These are the completion order of three stream-event mount lookups:
    // working, later working, then the older idle event. The registry, not a
    // particular route writer, must keep the original event order.
    publish("working", "2026-08-29T15:00:01.000Z");
    publish("working", "2026-08-29T15:00:03.000Z");
    publish("idle", "2026-08-29T15:00:02.000Z");

    expect(presences.listAgentsForViewer("drawing-1", "owner-user")).toEqual([
      expect.objectContaining({ runId: "run-ordered", status: "working" }),
    ]);
    expect(
      io.emissions.filter(
        (emission) =>
          emission.scope === "owner-socket" && emission.event === BOARD_AGENT_RUNTIME_EVENT,
      ),
    ).toHaveLength(2);
  });
});
