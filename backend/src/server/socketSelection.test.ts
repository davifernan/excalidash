import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import { PresenceRegistry } from "./presenceRegistry";
import { registerSocketHandlers } from "./socket";
import { registerAuthorizedRoomEvent } from "./socketRoomEvent";
import {
  parseSelectionPayload,
  SELECTION_LIMITS,
  type SelectionRoomPayload,
} from "./socketSelection";
import { FakeIo, FakeSocket, room } from "../__tests__/socketTestDoubles";

const validPayload = (selectedElementIds: unknown = ["element-1"]) => ({
  drawingId: "drawing-1",
  selectedElementIds,
});

describe("selection payload limits", () => {
  it("keeps an id list under budget and collapses an oversized list to one marker", () => {
    const realWorldSized = Array.from(
      { length: 5_043 },
      (_, index) => `imported-element-${index.toString().padStart(5, "0")}`,
    );
    realWorldSized.push(`foreign-${"x".repeat(300)}`);
    const accepted = parseSelectionPayload(validPayload(realWorldSized));
    expect(accepted?.selectedElementIds).toEqual(realWorldSized);

    const oversized = Array.from({ length: 30_000 }, (_, index) => `element-${index}`);
    expect(parseSelectionPayload(validPayload(oversized))).toEqual({
      drawingId: "drawing-1",
      allSelected: true,
    });
  });

  it.each(["element-1", ["ok", 42], { "element-1": true }])(
    "rejects a non-string-array selection: %j",
    (selectedElementIds) => {
      expect(parseSelectionPayload(validPayload(selectedElementIds))).toBeNull();
    },
  );
});

describe("authorized room event seam", () => {
  it("cannot invoke a feature handler without fresh room authorization", async () => {
    const socket = new FakeSocket("socket-a", []);
    const requireAccess = vi.fn().mockResolvedValue(null);
    const handle = vi.fn();
    registerAuthorizedRoomEvent<SelectionRoomPayload>({
      socket: socket as any,
      event: "selection-update",
      limit: 1,
      windowMs: 1_000,
      parse: parseSelectionPayload,
      requireAccess,
      handle,
    });

    await socket.trigger("selection-update", validPayload());

    expect(requireAccess).toHaveBeenCalledWith(socket, "drawing-1", false);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("selection room event", () => {
  const setup = () => {
    const io = new FakeIo();
    const presences = new PresenceRegistry();
    let allowed = true;
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: {
          findUnique: async () => (allowed ? { userId: BOOTSTRAP_USER_ID } : null),
        },
        drawingLinkShare: { findFirst: async () => null },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
      presences,
    });
    return { io, presences, revoke: () => (allowed = false) };
  };

  const join = async (socket: FakeSocket) => {
    await socket.trigger("join-room", {
      drawingId: "drawing-1",
      user: { name: "Local User", color: "#123456" },
    });
  };

  it("relays a bounded selection as an array and removes it through disconnect cleanup", async () => {
    const { io, presences } = setup();
    const sender = await io.connect("sender");
    const receiver = await io.connect("receiver");
    await join(sender);
    await join(receiver);
    io.emissions.length = 0;

    await sender.trigger("selection-update", validPayload(["a", "b"]));

    expect(presences.get("drawing-1", "sender")?.selectedElementIds).toEqual({ a: true, b: true });
    expect(io.emissions.at(-1)).toMatchObject({
      scope: room("drawing-1"),
      event: "selection-update",
      payload: { presenceId: "sender", selectedElementIds: ["a", "b"] },
    });

    await sender.trigger("disconnect");
    expect(presences.get("drawing-1", "sender")).toBeNull();
    expect(io.emissions.at(-1)).toMatchObject({
      event: "presence-update",
      payload: [expect.objectContaining({ presenceId: "receiver" })],
    });
  });

  it("relays and snapshots one marker instead of an over-budget id prefix", async () => {
    const { io, presences } = setup();
    const sender = await io.connect("sender");
    await join(sender);
    io.emissions.length = 0;
    const oversized = Array.from({ length: 30_000 }, (_, index) => `element-${index}`);

    await sender.trigger("selection-update", validPayload(oversized));

    expect(io.emissions.at(-1)).toMatchObject({
      scope: room("drawing-1"),
      event: "selection-update",
      payload: { drawingId: "drawing-1", presenceId: "sender", allSelected: true },
    });
    expect(io.emissions.at(-1)?.payload).not.toHaveProperty("selectedElementIds");
    expect(presences.get("drawing-1", "sender")).toMatchObject({
      selectedElementIds: {},
      allSelected: true,
    });

    const lateParticipant = await io.connect("late-participant");
    await join(lateParticipant);
    expect(
      io.emissions.findLast(
        (item) => item.scope === "late-participant" && item.event === "selection-snapshot",
      )?.payload,
    ).toEqual({
      drawingId: "drawing-1",
      selections: [{ presenceId: "sender", allSelected: true }],
    });
  });

  it("sends a late participant one private selection snapshot before later updates", async () => {
    const { io } = setup();
    const sender = await io.connect("sender");
    await join(sender);
    await sender.trigger("selection-update", validPayload(["selected-before-join"]));
    io.emissions.length = 0;

    const lateParticipant = await io.connect("late-participant");
    await join(lateParticipant);
    await sender.trigger("selection-update", validPayload(["selected-after-join"]));

    const snapshotIndex = io.emissions.findIndex(
      (item) => item.scope === "late-participant" && item.event === "selection-snapshot",
    );
    const laterUpdateIndex = io.emissions.findIndex(
      (item) => item.event === "selection-update" && item.payload.presenceId === "sender",
    );
    expect(io.emissions[snapshotIndex]?.payload).toEqual({
      drawingId: "drawing-1",
      selections: [{ presenceId: "sender", selectedElementIds: ["selected-before-join"] }],
    });
    expect(
      io.emissions.some(
        (item) => item.event === "selection-snapshot" && item.scope === room("drawing-1"),
      ),
    ).toBe(false);
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(laterUpdateIndex).toBeGreaterThan(snapshotIndex);
  });

  it("drops selection traffic after access revocation and uses the shared cleanup path", async () => {
    const { io, presences, revoke } = setup();
    const sender = await io.connect("sender");
    await join(sender);
    io.emissions.length = 0;
    revoke();

    await sender.trigger("selection-update", validPayload());

    expect(presences.get("drawing-1", "sender")).toBeNull();
    expect(io.emissions.some((item) => item.event === "selection-update")).toBe(false);
    expect(io.emissions.some((item) => item.event === "presence-update")).toBe(true);
  });

  it("removes selection state through the ordinary leave-room path", async () => {
    const { io, presences } = setup();
    const sender = await io.connect("sender");
    await join(sender);
    await sender.trigger("selection-update", validPayload());

    await sender.trigger("leave-room", { drawingId: "drawing-1" });

    expect(presences.get("drawing-1", "sender")).toBeNull();
    expect(io.emissions.at(-1)).toMatchObject({ event: "presence-update", payload: [] });
  });

  it("limits selection updates to forty events per second", async () => {
    const { io } = setup();
    const sender = await io.connect("sender");
    await join(sender);
    io.emissions.length = 0;

    for (let index = 0; index <= SELECTION_LIMITS.eventsPerSecond; index += 1) {
      await sender.trigger("selection-update", validPayload([`element-${index}`]));
    }

    expect(io.emissions.filter((item) => item.event === "selection-update")).toHaveLength(
      SELECTION_LIMITS.eventsPerSecond,
    );
  });

  it("does not hand out a second budget for a second connection", async () => {
    // A tab is free. If the budget lives on the connection, so is the budget,
    // and every limit on this socket is decoration. The shared allowance is
    // four times the per-connection one, so several tabs stay comfortable while
    // fifty of them buy nothing.
    const { io } = setup();
    const shared = SELECTION_LIMITS.eventsPerSecond * 4;
    const sockets = [];
    for (let index = 0; index < 5; index += 1) {
      const socket = await io.connect(`tab-${index}`);
      await join(socket);
      sockets.push(socket);
    }
    io.emissions.length = 0;

    for (let round = 0; round <= SELECTION_LIMITS.eventsPerSecond; round += 1) {
      for (const socket of sockets) {
        await socket.trigger("selection-update", validPayload([`element-${round}`]));
      }
    }

    const relayed = io.emissions.filter((item) => item.event === "selection-update");
    // Five tabs, each within its own allowance, still share one budget.
    expect(relayed).toHaveLength(shared);
    expect(relayed.length).toBeLessThan(sockets.length * SELECTION_LIMITS.eventsPerSecond);
  });
});
