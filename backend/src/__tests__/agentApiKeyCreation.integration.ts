/**
 * NIL-382: `POST /auth/api-keys` with a `drawingId` mints a drawing-bound
 * agent token instead of an account-wide key. This covers the part of the
 * creation flow that is not decidable by unit-testing `middleware/auth.ts`
 * alone: the server-side re-check that the caller actually has edit access
 * to the drawing they are naming, and the scope-namespace separation
 * (`drawing:*` here, `drawings:*`/`collections:*` on the account-wide path)
 * end to end through the real Express app and a real database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("Agent API key creation (NIL-382)", () => {
  const userAgent = "vitest-agent-api-key-creation";
  let prisma: PrismaClient;
  let app: any;

  let owner: { id: string; email: string };
  let stranger: { id: string; email: string };
  let drawingId: string;

  let ownerToken: string;
  let strangerToken: string;

  let ownerAgent: any;
  let ownerCsrfHeaderName: string;
  let ownerCsrfToken: string;

  let strangerAgent: any;
  let strangerCsrfHeaderName: string;
  let strangerCsrfToken: string;

  const signAccessToken = (user: { id: string; email: string }) => {
    const signOptions: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    return jwt.sign({ userId: user.id, email: user.email, type: "access" }, config.jwtSecret, signOptions);
  };

  const createUser = async (email: string, name: string) => {
    const passwordHash = await bcrypt.hash("password123", 10);
    return prisma.user.create({
      data: { email, passwordHash, name, role: "USER", isActive: true },
      select: { id: true, email: true },
    });
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });

    owner = await createUser("agent-key-owner@test.local", "Owner");
    stranger = await createUser("agent-key-stranger@test.local", "Stranger");
    ownerToken = signAccessToken(owner);
    strangerToken = signAccessToken(stranger);

    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", files: "{}", userId: owner.id },
      select: { id: true },
    });
    drawingId = drawing.id;

    ownerAgent = request.agent(app);
    const ownerCsrfRes = await ownerAgent.get("/csrf-token").set("User-Agent", userAgent);
    ownerCsrfHeaderName = ownerCsrfRes.body.header;
    ownerCsrfToken = ownerCsrfRes.body.token;

    strangerAgent = request.agent(app);
    const strangerCsrfRes = await strangerAgent.get("/csrf-token").set("User-Agent", userAgent);
    strangerCsrfHeaderName = strangerCsrfRes.body.header;
    strangerCsrfToken = strangerCsrfRes.body.token;
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("mints an agent token bound to a board the caller can edit, with a default 30-day expiry", async () => {
    const before = Date.now();
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "My Agent", drawingId });

    expect(res.status).toBe(201);
    expect(res.body.apiKey.drawingId).toBe(drawingId);
    expect(res.body.apiKey.scopes.sort()).toEqual(["drawing:ops", "drawing:read"]);
    expect(typeof res.body.token).toBe("string");

    const expiresAt = new Date(res.body.apiKey.expiresAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    // Allow test-runtime slack instead of an exact-millisecond match.
    expect(expiresAt).toBeGreaterThan(before + thirtyDaysMs - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(before + thirtyDaysMs + 60_000);
  });

  it("clamps a requested expiry to the 30-day maximum rather than honoring a longer one", async () => {
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Long-lived agent request", drawingId, expiresInDays: 90 });

    // The schema itself already rejects > 30, but this proves the server
    // enforces the cap rather than merely documenting it.
    expect(res.status).toBe(400);
  });

  it("honors a shorter requested expiry", async () => {
    const before = Date.now();
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Short-lived agent", drawingId, expiresInDays: 1 });

    expect(res.status).toBe(201);
    const expiresAt = new Date(res.body.apiKey.expiresAt).getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeLessThan(before + oneDayMs + 60_000);
  });

  it("mints a read-only agent token when only drawing:read is requested", async () => {
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Read-only agent", drawingId, scopes: ["drawing:read"] });

    expect(res.status).toBe(201);
    expect(res.body.apiKey.scopes).toEqual(["drawing:read"]);
  });

  it("rejects an account-wide scope on the agent-token path", async () => {
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Confused scopes", drawingId, scopes: ["drawings:read"] });

    expect(res.status).toBe(400);
  });

  it("REAL ATTACK: refuses to mint an agent token bound to a board the caller cannot edit", async () => {
    const res = await strangerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${strangerToken}`)
      .set(strangerCsrfHeaderName, strangerCsrfToken)
      .send({ name: "Someone else's board", drawingId });

    expect(res.status).toBe(404);

    // And no row was created for the stranger against this drawing -- the
    // 404 is a real refusal, not a response-shape accident over a key that
    // still landed in the database.
    const leaked = await prisma.apiKey.findFirst({
      where: { userId: stranger.id, drawingId },
    });
    expect(leaked).toBeNull();
  });

  it("still mints an ordinary account-wide key when drawingId is omitted", async () => {
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Account-wide key" });

    expect(res.status).toBe(201);
    expect(res.body.apiKey.drawingId).toBeNull();
    expect(res.body.apiKey.expiresAt).toBeNull();
    expect(res.body.apiKey.scopes.sort()).toEqual(
      ["collections:read", "collections:write", "drawings:read", "drawings:write"].sort(),
    );
  });

  it("rejects a drawing-bound scope on the account-wide path", async () => {
    const res = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Confused scopes", scopes: ["drawing:ops"] });

    expect(res.status).toBe(400);
  });
});
