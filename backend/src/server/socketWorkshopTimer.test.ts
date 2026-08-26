import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";
import {
  FakeIo,
  type FakeSocket,
  room,
  socketJoinSnapshotPrisma,
} from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";
import {
  WORKSHOP_TIMER_COMMAND_EVENT,
  WORKSHOP_TIMER_EVENT,
  createWorkshopTimerManager,
} from "./socketWorkshopTimer";

const startCommand = (durationMs = 10 * 60_000) => ({
  drawingId: "drawing-1",
  action: "start",
  durationMs,
});

const ownerSetup = () => {
  const io = new FakeIo();
  registerSocketHandlers({
    io: io as any,
    prisma: {
      drawing: { findUnique: async () => ({ userId: BOOTSTRAP_USER_ID }) },
      drawingLinkShare: { findFirst: async () => null },
    } as any,
    authModeService: { getAuthEnabled: async () => false } as any,
    jwtSecret: "test-secret",
  });
  return io;
};

const join = async (socket: FakeSocket, shareToken?: string) => {
  let acknowledgement: any;
  await socket.trigger(
    "join-room",
    { drawingId: "drawing-1", shareToken, user: { name: "Workshop User" } },
    (value: unknown) => {
      acknowledgement = value;
    },
  );
  return acknowledgement;
};

const timerUpdates = (io: FakeIo) =>
  io.emissions.filter((emission) => emission.event === WORKSHOP_TIMER_EVENT);

describe("workshop timer room event", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a view-only participant start the timer", async () => {
    const io = new FakeIo();
    const shareToken = buildShareLinkToken();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        ...socketJoinSnapshotPrisma(),
        drawingLinkShare: {
          findFirst: async () => ({
            permission: "view",
            tokenHash: hashShareLinkToken(shareToken),
          }),
        },
      } as any,
      authModeService: { getAuthEnabled: async () => true } as any,
      jwtSecret: "test-secret",
    });
    const viewer = await io.connect("viewer");
    expect((await join(viewer, shareToken))?.ok).toBe(true);
    io.emissions.length = 0;

    await viewer.trigger(WORKSHOP_TIMER_COMMAND_EVENT, startCommand());

    expect(timerUpdates(io)).toHaveLength(0);
    expect(io.emissions.at(-1)).toMatchObject({
      scope: "viewer",
      event: "error",
      payload: { message: "Read-only access: cannot edit this drawing" },
    });
  });

  it("limits each connection to twelve timer commands per minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const io = ownerSetup();
    const owner = await io.connect("owner");
    await join(owner);
    io.emissions.length = 0;

    for (let index = 0; index < 13; index += 1) {
      await owner.trigger(WORKSHOP_TIMER_COMMAND_EVENT, startCommand(60_000 + index));
    }

    expect(timerUpdates(io)).toHaveLength(12);
    await owner.trigger("disconnect");
  });

  it("sends the authoritative timer snapshot to a participant joining late", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const io = ownerSetup();
    const owner = await io.connect("owner");
    await join(owner);
    await owner.trigger(WORKSHOP_TIMER_COMMAND_EVENT, startCommand(90_000));
    vi.advanceTimersByTime(30_000);

    const lateParticipant = await io.connect("late-participant");
    await join(lateParticipant);

    expect(
      timerUpdates(io).findLast((emission) => emission.scope === "late-participant")?.payload,
    ).toEqual({
      drawingId: "drawing-1",
      status: "running",
      endsAt: 2_090_000,
      remainingMs: 60_000,
      durationMs: 90_000,
      serverNow: 2_030_000,
    });
    await owner.trigger("disconnect");
    await lateParticipant.trigger("disconnect");
  });

  it("removes timer state when the last participant leaves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const io = ownerSetup();
    const owner = await io.connect("owner");
    await join(owner);
    await owner.trigger(WORKSHOP_TIMER_COMMAND_EVENT, startCommand());
    await owner.trigger("disconnect");
    io.emissions.length = 0;

    const nextSession = await io.connect("next-session");
    await join(nextSession);

    expect(timerUpdates(io).at(-1)).toMatchObject({
      scope: "next-session",
      payload: {
        status: "idle",
        endsAt: null,
        remainingMs: 0,
        durationMs: null,
        serverNow: 3_000_000,
      },
    });
    await nextSession.trigger("disconnect");
  });

  it("announces expiry from the server", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    const io = new FakeIo();
    const timers = createWorkshopTimerManager({ io: io as any });

    timers.command(startCommand(1_000));
    vi.advanceTimersByTime(1_000);

    expect(timerUpdates(io).at(-1)).toMatchObject({
      scope: room("drawing-1"),
      payload: { status: "finished", durationMs: 1_000, serverNow: 4_001_000 },
    });
  });

  it("restarts from the authoritative configured duration, not the remaining time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const io = new FakeIo();
    const timers = createWorkshopTimerManager({ io: io as any });

    timers.command(startCommand(120_000));
    vi.advanceTimersByTime(35_000);
    timers.command({ drawingId: "drawing-1", action: "restart" });

    expect(timers.snapshot("drawing-1")).toEqual({
      drawingId: "drawing-1",
      status: "running",
      endsAt: 5_155_000,
      remainingMs: 120_000,
      durationMs: 120_000,
      serverNow: 5_035_000,
    });
  });
});
