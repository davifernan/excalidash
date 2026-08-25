import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";
import { FakeIo, FakeSocket, room, socketJoinSnapshotPrisma } from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";
import { VotingRegistry } from "./votingRegistry";
import {
  createSocketVotingManager,
  VOTING_CAST_EVENT,
  VOTING_COMMAND_EVENT,
  VOTING_STATE_EVENT,
} from "./socketVoting";

const stateEmissions = (io: FakeIo) =>
  io.emissions.filter((emission) => emission.event === VOTING_STATE_EVENT);

const openCommand = (overrides: Record<string, unknown> = {}) => ({
  drawingId: "drawing-1",
  action: "open",
  prompt: "Ship it?",
  options: ["Yes", "No"],
  ...overrides,
});

/**
 * Unlike `.mockResolvedValue("view")`, this actually reads the `requireEdit`
 * third argument. A regression that changed `socketVoting.ts`'s cast handler
 * from `requireAccess(socket, drawingId)` to
 * `requireAccess(socket, drawingId, true)` -- wrongly demanding edit access
 * to vote, locking viewers out of casting a ballot -- would resolve `null`
 * here and turn the cast's ack into `{ ok: false }`, instead of staying
 * invisible behind a mock that returns "view" no matter what it was asked
 * for (Hans-Friedrich, PR #65).
 */
const mockViewOnlyAccess = (requireAccess: ReturnType<typeof vi.fn>) => {
  requireAccess.mockImplementation((_socket: unknown, _drawingId: string, requireEdit?: boolean) =>
    Promise.resolve(requireEdit ? null : "view"),
  );
};

describe("voting command authorization (isolated manager)", () => {
  const setup = (access: unknown) => {
    const io = new FakeIo();
    const socket = new FakeSocket("mod-socket", io.emissions);
    socket.rooms.add(room("drawing-1"));
    const voting = new VotingRegistry();
    const requireAccess = vi.fn().mockResolvedValue(access);
    const manager = createSocketVotingManager({ io: io as any, voting, requireAccess });
    manager.registerHandlers(
      socket as any,
      () => true,
      () => true,
    );
    return { io, socket, voting, requireAccess };
  };

  it("rejects opening a round without edit access", async () => {
    const { socket, voting, io } = setup(null);
    const acks: unknown[] = [];
    await socket.trigger(VOTING_COMMAND_EVENT, openCommand(), (value: unknown) => acks.push(value));
    expect(voting.snapshot("drawing-1").status).toBe("idle");
    expect(acks).toEqual([
      { ok: false, error: { code: "access-denied", message: expect.any(String) } },
    ]);
    expect(stateEmissions(io)).toHaveLength(0);
  });

  it("lets an editor open a round and broadcasts it without a tally", async () => {
    const { socket, io } = setup("edit");
    const acks: unknown[] = [];
    await socket.trigger(VOTING_COMMAND_EVENT, openCommand(), (value: unknown) => acks.push(value));
    expect(acks).toEqual([{ ok: true }]);
    expect(stateEmissions(io)).toMatchObject([
      {
        scope: room("drawing-1"),
        payload: { status: "open", tally: null, participantCount: null },
      },
    ]);
  });

  it("never broadcasts anything to the room when a ballot is cast", async () => {
    const { socket, io, requireAccess } = setup("edit");
    await socket.trigger(VOTING_COMMAND_EVENT, openCommand());
    const roundId = stateEmissions(io).at(-1)?.payload.roundId;
    io.emissions.length = 0;

    mockViewOnlyAccess(requireAccess);
    const acks: unknown[] = [];
    await socket.trigger(
      VOTING_CAST_EVENT,
      { drawingId: "drawing-1", roundId, optionIds: ["0"] },
      (value: unknown) => acks.push(value),
    );

    expect(acks).toEqual([{ ok: true }]);
    // The only emission from a cast is the ack to the caster -- nothing goes
    // to the room, not even a participation pulse.
    expect(io.emissions).toHaveLength(0);
  });

  it("lets a view-only participant cast a ballot", async () => {
    const { socket, io, requireAccess } = setup("edit");
    await socket.trigger(VOTING_COMMAND_EVENT, openCommand());
    const roundId = stateEmissions(io).at(-1)?.payload.roundId;

    mockViewOnlyAccess(requireAccess);
    const acks: unknown[] = [];
    await socket.trigger(
      VOTING_CAST_EVENT,
      { drawingId: "drawing-1", roundId, optionIds: ["1"] },
      (value: unknown) => acks.push(value),
    );
    expect(acks).toEqual([{ ok: true }]);
  });

  it("rejects a ballot cast against a stale round id", async () => {
    const { socket, requireAccess } = setup("edit");
    await socket.trigger(VOTING_COMMAND_EVENT, openCommand());
    requireAccess.mockResolvedValue("view");
    const acks: unknown[] = [];
    await socket.trigger(
      VOTING_CAST_EVENT,
      { drawingId: "drawing-1", roundId: "not-the-current-round", optionIds: ["0"] },
      (value: unknown) => acks.push(value),
    );
    expect(acks).toEqual([
      { ok: false, error: { code: "round-changed", message: expect.any(String) } },
    ]);
  });

  it("broadcasts the tally to the room on reveal", async () => {
    const { socket, io, requireAccess } = setup("edit");
    await socket.trigger(VOTING_COMMAND_EVENT, openCommand());
    const roundId = stateEmissions(io).at(-1)?.payload.roundId;
    requireAccess.mockResolvedValue("view");
    await socket.trigger(VOTING_CAST_EVENT, {
      drawingId: "drawing-1",
      roundId,
      optionIds: ["0"],
    });
    requireAccess.mockResolvedValue("edit");
    io.emissions.length = 0;

    const acks: unknown[] = [];
    await socket.trigger(
      VOTING_COMMAND_EVENT,
      { drawingId: "drawing-1", action: "reveal" },
      (value: unknown) => acks.push(value),
    );

    expect(acks).toEqual([{ ok: true }]);
    expect(stateEmissions(io)).toMatchObject([
      { payload: { status: "revealed", tally: { "0": 1, "1": 0 }, participantCount: 1 } },
    ]);
  });

  it("rejects opening a round with a malformed prompt or option list", async () => {
    const { socket } = setup("edit");
    const acks: unknown[] = [];
    await socket.trigger(VOTING_COMMAND_EVENT, openCommand({ prompt: "" }), (value: unknown) =>
      acks.push(value),
    );
    await socket.trigger(
      VOTING_COMMAND_EVENT,
      openCommand({ options: ["only-one"] }),
      (value: unknown) => acks.push(value),
    );
    expect(acks).toEqual([
      { ok: false, error: { code: "invalid-request", message: expect.any(String) } },
      { ok: false, error: { code: "invalid-request", message: expect.any(String) } },
    ]);
  });
});

describe("voting wiring inside the real socket server", () => {
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

  it("sends the current round (without a tally) to someone joining mid-vote", async () => {
    const io = ownerSetup();
    const moderator = await io.connect("moderator");
    await join(moderator);
    await moderator.trigger(VOTING_COMMAND_EVENT, openCommand());

    const latecomer = await io.connect("latecomer");
    await join(latecomer);

    const pushed = io.emissions.find(
      (emission) => emission.event === VOTING_STATE_EVENT && emission.scope === "latecomer",
    );
    expect(pushed?.payload).toMatchObject({ status: "open", tally: null });
    await moderator.trigger("disconnect");
    await latecomer.trigger("disconnect");
  });

  it("clears the round once everyone leaves the drawing", async () => {
    const io = ownerSetup();
    const moderator = await io.connect("moderator");
    await join(moderator);
    await moderator.trigger(VOTING_COMMAND_EVENT, openCommand());
    await moderator.trigger("disconnect");

    const nextSession = await io.connect("next-session");
    await join(nextSession);

    const pushed = io.emissions.findLast(
      (emission) => emission.event === VOTING_STATE_EVENT && emission.scope === "next-session",
    );
    expect(pushed?.payload).toMatchObject({ status: "idle" });
    await nextSession.trigger("disconnect");
  });

  it("does not let a view-only link participant open a round", async () => {
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
    await join(viewer, shareToken);
    io.emissions.length = 0;

    await viewer.trigger(VOTING_COMMAND_EVENT, openCommand());

    expect(stateEmissions(io)).toHaveLength(0);
  });
});
