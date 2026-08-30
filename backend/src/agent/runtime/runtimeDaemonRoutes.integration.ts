import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asyncHandler } from "../../middleware/errorHandler";
import { getTestPrisma, initTestDb, setupTestDb } from "../../__tests__/testUtils";
import { OutboundRuntimeDaemonAdapter } from "./runtimeDaemonAdapter";
import { RuntimeDaemonBroker } from "./runtimeDaemonBroker";
import {
  registerRuntimeDaemonManagementRoutes,
  registerRuntimeDaemonPublicRoutes,
} from "./runtimeDaemonRoutes";
import { RuntimeDaemonService } from "./runtimeDaemonService";

describe("outbound runtime daemon public protocol (NIL-706)", () => {
  const prisma = getTestPrisma();
  const broker = new RuntimeDaemonBroker();
  const service = new RuntimeDaemonService(prisma, "0.16.0");
  const app = express();
  let userId = "";

  beforeAll(async () => {
    setupTestDb();
    const user = await initTestDb(prisma);
    userId = user.id;
    app.use(express.json());
    registerRuntimeDaemonPublicRoutes(app, { service, broker, asyncHandler });
    registerRuntimeDaemonManagementRoutes(app, {
      service,
      broker,
      asyncHandler,
      requireAuth: (req, _res, next) => {
        req.user = {
          id: userId,
          email: user.email,
          name: user.name,
          role: user.role,
        };
        next();
      },
    });
  });

  afterAll(async () => {
    await prisma.agentRuntimePairing.deleteMany();
    await prisma.agentRuntimeDaemon.deleteMany();
    await prisma.$disconnect();
  });

  const daemonIdentity = {
    daemonVersion: "0.16.0",
    profiles: [{ id: "codex", label: "Codex CLI" }],
  };

  const pair = async (label: string) => {
    const pairing = await request(app)
      .post("/agent/runtime-daemons/pairings")
      .send({ label })
      .expect(201);
    return request(app)
      .post("/agent/runtime-daemons/pair")
      .send({ pairingCode: pairing.body.pairingCode, ...daemonIdentity })
      .expect(201);
  };

  it("rejects registration without a valid one-use pairing and never stores the raw secret", async () => {
    const pairing = await request(app)
      .post("/agent/runtime-daemons/pairings")
      .send({ label: "Alice's laptop" })
      .expect(201);
    await request(app)
      .post("/agent/runtime-daemons/pair")
      .send({ pairingCode: `exd_pair_${"x".repeat(48)}`, ...daemonIdentity })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe("PAIRING_INVALID"));

    const paired = await request(app)
      .post("/agent/runtime-daemons/pair")
      .send({ pairingCode: pairing.body.pairingCode, ...daemonIdentity })
      .expect(201);
    const stored = await prisma.agentRuntimeDaemon.findUniqueOrThrow({
      where: { id: paired.body.daemonId },
    });
    expect(stored.credentialHash).not.toContain(paired.body.credential);
    expect(JSON.stringify(stored)).not.toContain(paired.body.credential);

    await request(app)
      .post("/agent/runtime-daemons/pair")
      .send({ pairingCode: pairing.body.pairingCode, ...daemonIdentity })
      .expect(401);
    const consumed = await prisma.agentRuntimePairing.findUniqueOrThrow({
      where: { id: pairing.body.pairingId },
    });
    expect(consumed.consumedAt).not.toBeNull();
  });

  it("rejects obsolete daemon versions before creating a device credential", async () => {
    const pairing = await request(app)
      .post("/agent/runtime-daemons/pairings")
      .send({ label: "Old laptop" })
      .expect(201);
    await request(app)
      .post("/agent/runtime-daemons/pair")
      .send({
        pairingCode: pairing.body.pairingCode,
        ...daemonIdentity,
        daemonVersion: "0.15.9",
      })
      .expect(426)
      .expect(({ body }) => expect(body.code).toBe("DAEMON_VERSION_UNSUPPORTED"));
  });

  it("fences an assignment response from every daemon except its paired owner", async () => {
    const [pairedA, pairedB] = await Promise.all([pair("Laptop A"), pair("Laptop B")]);
    const open = (credential: string) =>
      request(app)
        .post("/agent/runtime-daemons/session")
        .set("authorization", `Bearer ${credential}`)
        .send(daemonIdentity)
        .expect(201);
    const [sessionA, sessionB] = await Promise.all([
      open(pairedA.body.credential),
      open(pairedB.body.credential),
    ]);

    const connectionA = broker.resolve(`daemon:${pairedA.body.daemonId}`, userId);
    expect(connectionA).not.toBeNull();
    expect(broker.resolve(`daemon:${pairedA.body.daemonId}`, "another-user")).toBeNull();
    expect(broker.listConnections("another-user")).toEqual([]);
    const adapter = new OutboundRuntimeDaemonAdapter(broker);
    const started = adapter.start(connectionA!, {
      assignmentId: "assignment-fenced",
      profileId: "codex",
      displayName: "Board agent",
      runId: "run-fenced",
      drawingId: "drawing-fenced",
    });
    const delivery = await request(app)
      .post("/agent/runtime-daemons/commands/next")
      .set("authorization", `Bearer ${pairedA.body.credential}`)
      .send({ epoch: sessionA.body.epoch })
      .expect(200);
    const commandId = delivery.body.command.commandId;

    await request(app)
      .post("/agent/runtime-daemons/events")
      .set("authorization", `Bearer ${pairedB.body.credential}`)
      .send({
        kind: "command-result",
        epoch: sessionB.body.epoch,
        commandId,
        result: { ok: true, runtimeHandle: "stolen", status: "working" },
      })
      .expect(422)
      .expect(({ body }) => expect(body.message).toContain("does not belong"));

    await request(app)
      .post("/agent/runtime-daemons/events")
      .set("authorization", `Bearer ${pairedA.body.credential}`)
      .send({
        kind: "command-result",
        epoch: sessionA.body.epoch,
        commandId,
        result: { ok: true, runtimeHandle: "codex-thread-1", status: "working" },
      })
      .expect(202);
    await expect(started).resolves.toMatchObject({ status: "working" });
  });

  it("fences an older epoch after the same daemon opens a new session", async () => {
    const paired = await pair("Reconnecting laptop");
    const open = () =>
      request(app)
        .post("/agent/runtime-daemons/session")
        .set("authorization", `Bearer ${paired.body.credential}`)
        .send(daemonIdentity)
        .expect(201);
    const oldSession = await open();
    const newSession = await open();
    expect(newSession.body.epoch).toBe(oldSession.body.epoch + 1);
    const current = await service.authenticate(paired.body.credential);
    broker.activate({ ...current, sessionEpoch: oldSession.body.epoch });
    expect(
      (broker.resolve(`daemon:${paired.body.daemonId}`, userId)?.adapterConfig as { epoch: number })
        .epoch,
    ).toBe(newSession.body.epoch);
    await request(app)
      .post("/agent/runtime-daemons/commands/next")
      .set("authorization", `Bearer ${paired.body.credential}`)
      .send({ epoch: oldSession.body.epoch })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe("SESSION_FENCED"));
  });

  it("revokes both the credential and an already active connection", async () => {
    const paired = await pair("Revoked laptop");
    const session = await request(app)
      .post("/agent/runtime-daemons/session")
      .set("authorization", `Bearer ${paired.body.credential}`)
      .send(daemonIdentity)
      .expect(201);
    expect(broker.resolve(`daemon:${paired.body.daemonId}`, userId)).not.toBeNull();
    await request(app).delete(`/agent/runtime-daemons/${paired.body.daemonId}`).expect(204);
    expect(broker.resolve(`daemon:${paired.body.daemonId}`, userId)).toBeNull();
    await request(app)
      .get("/agent/runtime-daemons")
      .expect(200)
      .expect(({ body }) =>
        expect(body.daemons.map((daemon: { id: string }) => daemon.id)).not.toContain(
          paired.body.daemonId,
        ),
      );
    await request(app)
      .post("/agent/runtime-daemons/commands/next")
      .set("authorization", `Bearer ${paired.body.credential}`)
      .send({ epoch: session.body.epoch })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe("DEVICE_CREDENTIAL_INVALID"));
  });
});
