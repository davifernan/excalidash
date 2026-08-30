import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../generated/client";
import request from "supertest";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { StringValue } from "ms";
import { registerAgentContext } from "../../agent/boardContexts";
import { getTestPrisma, setupTestDb } from "../../__tests__/testUtils";
import { config } from "../../config";

/**
 * NIL-680's REST surface, exercised through the real HTTP stack -- the same
 * "Fertig, wenn" criteria as contextLease.integration.ts, but proving the
 * route/auth wiring around the primitive, not just the primitive itself.
 */
describe("Context Lease HTTP routes (NIL-680)", () => {
  let prisma: PrismaClient;
  let app: any;
  let owner: { id: string; email: string };
  let member: { id: string; email: string };

  const sign = (user: { id: string; email: string }) => {
    const options: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      options,
    );
  };

  const frame = (id: string) => ({
    id,
    type: "frame",
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    angle: 0,
    isDeleted: false,
  });

  const authedRequest = (asUser: { id: string; email: string }) => {
    const client = request.agent(app);
    const withAuth = async (
      build: (req: request.Test) => request.Test,
    ): Promise<request.Response> => {
      const csrf = await client.get("/csrf-token").set("User-Agent", "nil680-test");
      return build(
        client.set("User-Agent", "nil680-test").set("Authorization", `Bearer ${sign(asUser)}`),
      ).set(csrf.body.header, csrf.body.token);
    };
    return withAuth;
  };

  const buildContext = async (frameId: string) => {
    const drawing = await prisma.drawing.create({
      data: {
        name: `NIL-680 board ${frameId}`,
        elements: JSON.stringify([frame(frameId)]),
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
    });
    const registration = await registerAgentContext({
      prisma,
      drawingId: drawing.id,
      frameElementId: frameId,
    });
    return { drawingId: drawing.id, contextId: registration.id };
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
    owner = await prisma.user.create({
      data: { email: "nil680-owner@test.local", passwordHash: "not-used", name: "Owner" },
      select: { id: true, email: true },
    });
    member = await prisma.user.create({
      data: { email: "nil680-member@test.local", passwordHash: "not-used", name: "Member" },
      select: { id: true, email: true },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("grants exactly one of two concurrent HTTP acquire requests, with a 409 busy response for the loser", async () => {
    const { drawingId, contextId } = await buildContext("http-race-frame");
    const endHorizonAt = new Date(Date.now() + 300_000).toISOString();
    const requestAs = authedRequest(owner);
    const acquireBody = (runId: string) => ({
      holderOrchestratorId: `orchestrator-${runId}`,
      runId,
      ttlMs: 60_000,
      endHorizonAt,
    });

    const [a, b] = await Promise.all([
      requestAs((req) =>
        req
          .post(`/drawings/${drawingId}/agent/contexts/${contextId}/lease/acquire`)
          .send(acquireBody("run-http-a")),
      ),
      requestAs((req) =>
        req
          .post(`/drawings/${drawingId}/agent/contexts/${contextId}/lease/acquire`)
          .send(acquireBody("run-http-b")),
      ),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const busy = a.status === 409 ? a : b;
    expect(busy.body.code).toBe("CONTEXT_LEASE_HELD");
    expect(busy.body.heldBy.runId).toMatch(/^run-http-[ab]$/);
  });

  it("returns 404 for a lease request against a drawing that does not exist, for an authenticated caller", async () => {
    const { contextId } = await buildContext("http-auth-frame");
    const requestAs = authedRequest(owner);
    const response = await requestAs((req) =>
      req
        .post(`/drawings/does-not-exist/agent/contexts/${contextId}/lease/acquire`)
        .send({
          holderOrchestratorId: "x",
          runId: "y",
          ttlMs: 1000,
          endHorizonAt: new Date().toISOString(),
        }),
    );
    expect(response.status).toBe(404);
  });

  it("denies a non-owner transfer override even when requested, but honors the holder's own consent transfer", async () => {
    const { drawingId, contextId } = await buildContext("http-transfer-frame");
    await prisma.drawingPermission.create({
      data: { drawingId, granteeUserId: member.id, permission: "edit", createdByUserId: owner.id },
    });
    const ownerReq = authedRequest(owner);
    const memberReq = authedRequest(member);
    const endHorizonAt = new Date(Date.now() + 300_000).toISOString();

    const acquired = await ownerReq((req) =>
      req.post(`/drawings/${drawingId}/agent/contexts/${contextId}/lease/acquire`).send({
        holderOrchestratorId: "orchestrator-owner",
        runId: "run-owner",
        ttlMs: 60_000,
        endHorizonAt,
      }),
    );
    expect(acquired.status).toBe(201);
    const leaseGeneration = acquired.body.lease.leaseGeneration;

    // A member who is neither the holder nor the owner cannot force a takeover.
    const denied = await memberReq((req) =>
      req.post(`/drawings/${drawingId}/agent/contexts/${contextId}/lease/transfer`).send({
        leaseGeneration,
        fromRunId: "not-the-holder",
        toOrchestratorId: "orchestrator-member",
        toRunId: "run-member",
        ttlMs: 60_000,
        requestOverride: true,
      }),
    );
    expect(denied.status).toBe(403);

    // The holder's own request (owner, consenting) succeeds without needing override.
    const consented = await ownerReq((req) =>
      req.post(`/drawings/${drawingId}/agent/contexts/${contextId}/lease/transfer`).send({
        leaseGeneration,
        fromRunId: "run-owner",
        toOrchestratorId: "orchestrator-member",
        toRunId: "run-member",
        ttlMs: 60_000,
      }),
    );
    expect(consented.status).toBe(200);
    expect(consented.body.lease.runId).toBe("run-member");
  });
});
