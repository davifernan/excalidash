import { describe, it, expect, vi } from "vitest";
import { getTestPrisma, setupTestDb } from "../__tests__/testUtils";
import { issueBootstrapSetupCodeIfRequired } from "./bootstrapSetupCode";
import { BOOTSTRAP_USER_ID } from "./authMode";

/**
 * Guards a cross-package contract that NIL-506's logging migration broke
 * once already: e2e/tests/helpers/authLifecycle.ts's readLatestBootstrapSetupCode
 * scrapes the backend's own log output for this exact line to read the
 * one-time admin setup code (never returned over HTTP, see
 * bootstrapSetupCode.ts). Before NIL-504, that was a hand-formatted
 * `console.log` string; after, it is one JSON object from logger.ts.
 * scripts/logging-boundary.cjs enforces WHERE a backend log line is written
 * (logger.ts, not console.*) but has no way to know that something outside
 * backend/src depends on a log line's exact SHAPE -- e2e/tests/helpers/
 * comments-two-account.spec.ts and discovery-permission-matrix.spec.ts both
 * went red in CI when the shape changed and nothing local caught it. This
 * test is the local catch: it drives the real function against a real test
 * DB (not a hand-typed simulation of what logger.ts would produce) and
 * parses its captured output with the identical logic authLifecycle.ts
 * uses, so a future change to this message/fields fails here before CI.
 */
const BOOTSTRAP_CODE_MESSAGE = "BOOTSTRAP SETUP: one-time admin setup code issued";

describe("bootstrap setup code E2E-parser compatibility", () => {
  it("emits a log line the E2E helper's JSON parser can read", async () => {
    setupTestDb();
    const prisma = getTestPrisma();

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true },
      create: { id: "default", authEnabled: true },
    });
    await prisma.user.upsert({
      where: { id: BOOTSTRAP_USER_ID },
      update: { isActive: false },
      create: {
        id: BOOTSTRAP_USER_ID,
        email: "bootstrap@excalidash.local",
        name: "Bootstrap Admin",
        role: "ADMIN",
        isActive: false,
        passwordHash: "unused",
      },
    });

    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });

    await issueBootstrapSetupCodeIfRequired({
      prisma,
      ttlMs: 900000,
      authMode: "local",
      reason: "auth_enabled_toggle",
    });

    vi.restoreAllMocks();

    const content = writes.join("");
    const lines = content
      .split("\n")
      .filter((l) => l.includes(BOOTSTRAP_CODE_MESSAGE))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((p) => p !== null && p.message === BOOTSTRAP_CODE_MESSAGE);

    expect(lines.length).toBe(1);
    expect(lines[0].reason).toBe("auth_enabled_toggle");
    expect(typeof lines[0].code).toBe("string");
    expect(lines[0].code.length).toBeGreaterThan(0);
  });
});
