import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { configureSecuritySettings, resetSecuritySettings } from "../security";
import { getTestPrisma, setupTestDb } from "./testUtils";

const IMAGE_DATA_URL_TOO_LARGE = "IMAGE_DATA_URL_TOO_LARGE";
const MAX_DATA_URL_BYTES = 128;
const USER_AGENT = "vitest-oversized-image";
// Base64 for a unique image-payload marker. Keeping it valid base64 proves the
// rejection is caused by size, not malformed image material.
const MATERIAL_SENTINEL = "SU1BR0VfTUFURVJJQUxfU0VOVElORUw=";
const SECRET_SENTINEL = "SECRET_SENTINEL";

const oversizedFiles = () => ({
  image: {
    id: "image",
    mimeType: "image/png",
    dataURL: `data:image/png;base64,${"A".repeat(MAX_DATA_URL_BYTES)}${MATERIAL_SENTINEL}`,
    encryptionKey: SECRET_SENTINEL,
  },
});

describe("oversized image drawing mutations", () => {
  let prisma: PrismaClient;
  let app: any;
  let agent: any;
  let csrfHeaderName: string;
  let csrfToken: string;
  let accessToken: string;
  let userId: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, authOnboardingCompleted: true },
      create: {
        id: "default",
        authEnabled: true,
        authOnboardingCompleted: true,
        registrationEnabled: false,
      },
    });
    const user = await prisma.user.create({
      data: {
        email: "oversized-image@test.local",
        passwordHash: await bcrypt.hash("password123", 10),
        name: "Oversized Image Test",
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true },
    });
    userId = user.id;
    const signOptions: SignOptions = {
      expiresIn: config.jwtAccessExpiresIn as StringValue,
    };
    accessToken = jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );

    agent = request.agent(app);
    const csrfResponse = await agent.get("/csrf-token").set("User-Agent", USER_AGENT);
    csrfHeaderName = csrfResponse.body.header;
    csrfToken = csrfResponse.body.token;
  });

  beforeEach(async () => {
    resetSecuritySettings();
    configureSecuritySettings({ maxDataUrlSize: MAX_DATA_URL_BYTES });
    await prisma.drawing.deleteMany({});
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    resetSecuritySettings();
    await prisma.$disconnect();
  });

  const mutate = (method: "post" | "put", path: string, body: Record<string, unknown>) =>
    agent[method](path)
      .set("User-Agent", USER_AGENT)
      .set("Authorization", `Bearer ${accessToken}`)
      .set(csrfHeaderName, csrfToken)
      .send(body);

  const expectSafeStructuredRejection = (response: request.Response) => {
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "Validation error",
      code: IMAGE_DATA_URL_TOO_LARGE,
      message: "Image data URL exceeds the configured storage limit.",
      details: { maxBytes: MAX_DATA_URL_BYTES },
    });
    const responseText = JSON.stringify(response.body);
    expect(responseText).not.toContain(MATERIAL_SENTINEL);
    expect(responseText).not.toContain(SECRET_SENTINEL);
  };

  it("rejects create before any drawing can be persisted", async () => {
    const files = oversizedFiles();
    const encodedImage = files.image.dataURL.split(",")[1];
    expect(Buffer.from(encodedImage, "base64").toString("base64")).toBe(encodedImage);

    const response = await mutate("post", "/drawings", {
      name: "Must Not Exist",
      elements: [],
      appState: {},
      files,
    });

    expectSafeStructuredRejection(response);
    expect(await prisma.drawing.count()).toBe(0);
  });

  it("rejects update without changing files, metadata, version, or snapshots", async () => {
    const originalFiles = {
      original: {
        id: "original",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
      },
    };
    const drawing = await prisma.drawing.create({
      data: {
        name: "Original Name",
        elements: "[]",
        appState: "{}",
        files: JSON.stringify(originalFiles),
        userId,
      },
      select: { id: true, version: true },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await mutate("put", `/drawings/${drawing.id}`, {
      name: "Must Not Persist",
      elements: [{ id: "must-not-persist", type: "rectangle" }],
      appState: { viewBackgroundColor: "#123456" },
      files: oversizedFiles(),
      version: drawing.version,
    });

    expectSafeStructuredRejection(response);
    const persisted = await prisma.drawing.findUniqueOrThrow({ where: { id: drawing.id } });
    expect(persisted.name).toBe("Original Name");
    expect(persisted.elements).toBe("[]");
    expect(persisted.appState).toBe("{}");
    expect(persisted.files).toBe(JSON.stringify(originalFiles));
    expect(persisted.files).not.toContain('"dataURL":""');
    expect(persisted.version).toBe(drawing.version);
    expect(await prisma.drawingSnapshot.count({ where: { drawingId: drawing.id } })).toBe(0);

    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain(MATERIAL_SENTINEL);
    expect(logged).not.toContain(SECRET_SENTINEL);
  });
});
