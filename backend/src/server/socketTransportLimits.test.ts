import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import { FakeIo, type FakeSocket } from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";
import { parseElementUpdatePayload, SOCKET_LIMITS } from "./socketProtocol";

const fullRectangle = (index: number) => ({
  id: `element-${index.toString(36).padStart(8, "0")}`,
  type: "rectangle",
  x: index * 10,
  y: index * 4,
  width: 160,
  height: 80,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roundness: { type: 3 },
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: `a${index.toString(36)}`,
  seed: 123_456_789 + index,
  version: 1,
  versionNonce: 987_654_321 - index,
  isDeleted: false,
  boundElements: null,
  updated: 1_720_000_000_000,
  link: null,
  locked: false,
});

const drawingId = "00000000-0000-0000-0000-000000000000";

describe("element-update transport limits", () => {
  const connectGuests = async (
    boardIds: string[],
    trafficLimits: {
      accountBytesPerWindow: number;
      anonymousBytesPerWindow: number;
      accountActorBytesPerWindow: number;
      anonymousActorBytesPerWindow: number;
      windowMs: number;
    },
  ) => {
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: vi.fn().mockResolvedValue({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
      elementUpdateTrafficLimits: trafficLimits,
    });
    const sockets = await Promise.all(
      boardIds.map(async (boardId, index) => {
        const socket = await io.connect(`guest-${index}`);
        await socket.trigger("join-room", { drawingId: boardId, user: {} });
        return socket;
      }),
    );
    io.emissions.length = 0;
    return { io, sockets };
  };

  it("rejects an oversized serialized payload", () => {
    expect(
      parseElementUpdatePayload({
        drawingId,
        elements: [fullRectangle(0)],
        ignored: "x".repeat(SOCKET_LIMITS.elementUpdateBytes),
      }),
    ).toBeNull();
  });

  it("answers an over-event but under-transport payload with a size reason", async () => {
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: vi.fn().mockResolvedValue({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
    });
    const sender = await io.connect("sender");
    await sender.trigger("join-room", { drawingId, user: {} });

    const answers: unknown[] = [];
    await sender.trigger(
      "element-update",
      {
        drawingId,
        elements: [fullRectangle(0)],
        ignored: "x".repeat(SOCKET_LIMITS.elementUpdateBytes),
      },
      (value: unknown) => answers.push(value),
    );

    expect(answers).toEqual([
      {
        ok: false,
        error: {
          code: "payload-too-large",
          message: "element-update exceeds the per-event byte limit",
        },
      },
    ]);
    expect(sender.disconnected).toBe(false);
  });

  it("rejects an oversized individual element", () => {
    expect(
      parseElementUpdatePayload({
        drawingId,
        elements: [
          {
            ...fullRectangle(0),
            customData: { padding: "x".repeat(SOCKET_LIMITS.elementBytes) },
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects implausible element and file field types", () => {
    expect(
      parseElementUpdatePayload({
        drawingId,
        elements: [{ ...fullRectangle(0), x: "not-a-coordinate" }],
      }),
    ).toBeNull();
    expect(
      parseElementUpdatePayload({
        drawingId,
        elements: [],
        files: { image: { id: "image", mimeType: "image/png", dataURL: 123 } },
      }),
    ).toBeNull();
  });

  it("rejects a string field far past any realistic value, even under the whole-element budget", () => {
    // Comfortably below elementBytes, so only a per-field cap catches this.
    expect(
      parseElementUpdatePayload({
        drawingId,
        elements: [{ ...fullRectangle(0), strokeColor: "x".repeat(1_000) }],
      }),
    ).toBeNull();
  });

  it("accepts an ordinary element-update with realistic field values", () => {
    const parsed = parseElementUpdatePayload({ drawingId, elements: [fullRectangle(0)] });
    expect(parsed).not.toBeNull();
    expect(parsed?.elements).toEqual([fullRectangle(0)]);
  });

  it("rejects updates above the element-count ceiling", () => {
    const elements = Array.from({ length: SOCKET_LIMITS.elementsPerUpdate + 1 }, (_, index) => ({
      id: `element-${index}`,
      type: "rectangle",
    }));

    expect(parseElementUpdatePayload({ drawingId, elements })).toBeNull();
  });

  it("accepts a measured large 5,000-element scene with its full order", () => {
    const elements = Array.from({ length: 5_000 }, (_, index) => fullRectangle(index));
    const elementOrder = elements.map((element) => element.id);

    const parsed = parseElementUpdatePayload({ drawingId, elements, elementOrder });

    expect(parsed).not.toBeNull();
    expect(parsed?.elements).toHaveLength(5_000);
    expect(parsed?.serializedBytes).toBe(2_349_861);
    expect(parsed!.serializedBytes).toBeLessThan(SOCKET_LIMITS.elementUpdateBytes);
  });

  it("shares byte budgets by address for guests and by account for signed-in users", async () => {
    const payload = { drawingId: "drawing-1", elements: [fullRectangle(0)] };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const trafficLimits = {
      accountBytesPerWindow: payloadBytes,
      anonymousBytesPerWindow: payloadBytes,
      accountActorBytesPerWindow: payloadBytes * 4,
      anonymousActorBytesPerWindow: payloadBytes * 4,
      windowMs: 1_000,
    };
    const join = (socket: FakeSocket) =>
      socket.trigger("join-room", { drawingId: "drawing-1", user: {} });

    const guestIo = new FakeIo();
    registerSocketHandlers({
      io: guestIo as any,
      prisma: {
        drawing: { findUnique: vi.fn().mockResolvedValue({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
      elementUpdateTrafficLimits: trafficLimits,
    });
    const firstGuest = await guestIo.connect("guest-one");
    const sameAddressGuest = await guestIo.connect("guest-two");
    const otherAddressGuest = await guestIo.connect("guest-three");
    otherAddressGuest.handshake.address = "203.0.113.10";
    await Promise.all([join(firstGuest), join(sameAddressGuest), join(otherAddressGuest)]);
    guestIo.emissions.length = 0;

    await firstGuest.trigger("element-update", payload);
    await sameAddressGuest.trigger("element-update", payload);
    await otherAddressGuest.trigger("element-update", payload);
    expect(guestIo.emissions.filter((item) => item.event === "element-update")).toHaveLength(2);

    const strictGuestIo = new FakeIo();
    registerSocketHandlers({
      io: strictGuestIo as any,
      prisma: {
        drawing: { findUnique: vi.fn().mockResolvedValue({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
      elementUpdateTrafficLimits: {
        ...trafficLimits,
        anonymousBytesPerWindow: SOCKET_LIMITS.elementUpdateBytes,
      },
    });
    const strictGuest = await strictGuestIo.connect("strict-guest");
    await join(strictGuest);
    strictGuestIo.emissions.length = 0;
    await strictGuest.trigger("element-update", {
      ...payload,
      ignored: "x".repeat(SOCKET_LIMITS.anonymousElementUpdateBytes),
    });
    expect(strictGuestIo.emissions.filter((item) => item.event === "element-update")).toHaveLength(
      0,
    );

    const accountIo = new FakeIo();
    const accountPrisma = {
      drawing: {
        findUnique: vi.fn().mockResolvedValue({ userId: "account-1", collectionId: null }),
      },
      drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "account-1",
          isActive: true,
          name: "Account One",
        }),
      },
    };
    registerSocketHandlers({
      io: accountIo as any,
      prisma: accountPrisma as any,
      authModeService: { getAuthEnabled: async () => true } as any,
      jwtSecret: "test-secret",
      elementUpdateTrafficLimits: trafficLimits,
    });
    const token = jwt.sign(
      { userId: "account-1", email: "one@example.test", type: "access" },
      "test-secret",
    );
    const firstAccount = await accountIo.connect("account-one", { token });
    const secondAccount = await accountIo.connect("account-two", { token });
    secondAccount.handshake.address = "203.0.113.20";
    await Promise.all([join(firstAccount), join(secondAccount)]);
    accountIo.emissions.length = 0;

    await firstAccount.trigger("element-update", payload);
    await secondAccount.trigger("element-update", payload);
    expect(accountIo.emissions.filter((item) => item.event === "element-update")).toHaveLength(1);
  });

  it("does not spend one actor's board budget on another board", async () => {
    const payload = { drawingId: "board-a", elements: [fullRectangle(0)] };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const { io, sockets } = await connectGuests(["board-a", "board-a", "board-b"], {
      accountBytesPerWindow: payloadBytes,
      anonymousBytesPerWindow: payloadBytes,
      accountActorBytesPerWindow: payloadBytes * 2,
      anonymousActorBytesPerWindow: payloadBytes * 2,
      windowMs: 1_000,
    });

    await sockets[0].trigger("element-update", payload);
    await sockets[1].trigger("element-update", payload);
    await sockets[2].trigger("element-update", { ...payload, drawingId: "board-b" });

    expect(io.emissions.filter((item) => item.event === "element-update")).toHaveLength(2);
  });

  it("caps one actor's element bytes across many boards", async () => {
    const payload = { drawingId: "board-a", elements: [fullRectangle(0)] };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const { io, sockets } = await connectGuests(["board-a", "board-b", "board-c"], {
      accountBytesPerWindow: payloadBytes,
      anonymousBytesPerWindow: payloadBytes,
      accountActorBytesPerWindow: payloadBytes * 2,
      anonymousActorBytesPerWindow: payloadBytes * 2,
      windowMs: 1_000,
    });

    for (const [index, socket] of sockets.entries()) {
      await socket.trigger("element-update", {
        ...payload,
        drawingId: `board-${String.fromCharCode(97 + index)}`,
      });
    }

    expect(io.emissions.filter((item) => item.event === "element-update")).toHaveLength(2);
  });

  it("tells the sender when a change was refused, and tells only them", async () => {
    // The change is still saved over HTTP, so nothing is lost. What is lost is
    // the live sharing -- and without a word the sender keeps drawing while
    // nobody else sees any of it.
    const payload = { drawingId: "drawing-1", elements: [fullRectangle(0)] };
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: vi.fn().mockResolvedValue({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
      elementUpdateTrafficLimits: {
        // No budget at all, so the very first change is refused.
        accountBytesPerWindow: 0,
        anonymousBytesPerWindow: 0,
        accountActorBytesPerWindow: 0,
        anonymousActorBytesPerWindow: 0,
        windowMs: 1_000,
      },
    });
    const sender = await io.connect("sender");
    const bystander = await io.connect("bystander");
    await Promise.all([
      sender.trigger("join-room", { drawingId: "drawing-1", user: {} }),
      bystander.trigger("join-room", { drawingId: "drawing-1", user: {} }),
    ]);
    io.emissions.length = 0;

    const answers: unknown[] = [];
    // Twelve, past the ten hard failures that close a connection: a client on a
    // board too large to relay would otherwise be thrown off for it.
    for (let index = 0; index < 12; index += 1) {
      await sender.trigger("element-update", payload, (value: unknown) => answers.push(value));
    }
    expect(answers).toHaveLength(12);
    expect(sender.disconnected).toBe(false);
    answers.length = 1;

    // Answered on the sender's own callback rather than left to time out, so a
    // client that has already drawn the change learns straight away that nobody
    // else received it.
    expect(answers).toEqual([
      { ok: false, error: { code: "rate-limited", message: "element-update rate limit exceeded" } },
    ]);
    // Refused means refused: nobody else saw the change either.
    expect(io.emissions.filter((item) => item.event === "element-update")).toHaveLength(0);
    // And a refusal is a budget, not misbehaviour -- the connection stays up.
    expect(sender.disconnected).not.toBe(true);
  });
  it("refuses an ordering that names the same element more than once", () => {
    // Defence in depth for the receiver, which now also places each element
    // once. On its own the ordering is tiny -- a few hundred short ids -- and
    // it used to expand into one scene entry per mention on every client.
    const elements = [fullRectangle(0), fullRectangle(1)];
    const ids = elements.map((element) => element.id);
    expect(parseElementUpdatePayload({ drawingId, elements, elementOrder: ids })).not.toBeNull();
    expect(
      parseElementUpdatePayload({
        drawingId,
        elements,
        elementOrder: [ids[0], ids[1], ids[0]],
      }),
    ).toBeNull();
  });
});
