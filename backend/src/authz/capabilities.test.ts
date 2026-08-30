import { describe, expect, it, vi } from "vitest";
import {
  combineGuestCapabilities,
  getBoardGuestCapabilityPolicy,
  getInstanceGuestCapabilities,
  HISTORICAL_GUEST_CAPABILITY_DEFAULTS,
  setBoardGuestCapabilityPolicy,
  setInstanceGuestCapabilities,
} from "./capabilities";

const buildPrisma = (overrides: Record<string, any> = {}) => ({
  systemConfig: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
  },
  drawing: {
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
  },
  ...overrides,
});

describe("instance guest capability ceiling", () => {
  it("falls back to the historical defaults while no SystemConfig row exists", async () => {
    const prisma = buildPrisma();
    const result = await getInstanceGuestCapabilities(prisma as any, "default");
    expect(result).toEqual(HISTORICAL_GUEST_CAPABILITY_DEFAULTS);
  });

  it("reads the persisted instance policy once a row exists", async () => {
    const prisma = buildPrisma({
      systemConfig: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ guestUploadEnabled: true, guestCommentVisibilityEnabled: false }),
      },
    });
    const result = await getInstanceGuestCapabilities(prisma as any, "default");
    expect(result).toEqual({
      uploadFiles: true,
      viewComments: false,
      agentContextContribute: false,
    });
  });

  it("only writes the field that was actually passed", async () => {
    const upsert = vi.fn().mockResolvedValue({
      guestUploadEnabled: true,
      guestCommentVisibilityEnabled: true,
    });
    const prisma = buildPrisma({ systemConfig: { upsert } });

    await setInstanceGuestCapabilities(prisma as any, { uploadFiles: true }, "default");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { guestUploadEnabled: true },
      }),
    );
  });
});

describe("board guest capability policy", () => {
  it("falls back to the historical defaults while the drawing has no explicit policy", async () => {
    const prisma = buildPrisma();
    const result = await getBoardGuestCapabilityPolicy(prisma as any, "drawing-1");
    expect(result).toEqual(HISTORICAL_GUEST_CAPABILITY_DEFAULTS);
  });

  it("writes only the requested board field", async () => {
    const update = vi.fn().mockResolvedValue({
      guestUploadEnabled: false,
      guestCommentVisibilityEnabled: false,
    });
    const prisma = buildPrisma({ drawing: { update } });

    await setBoardGuestCapabilityPolicy(prisma as any, "drawing-1", { viewComments: false });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "drawing-1" },
        data: { guestCommentVisibilityEnabled: false },
      }),
    );
  });
});

describe("combineGuestCapabilities", () => {
  it("is AND, per function: a board cannot raise what the instance closed", () => {
    expect(
      combineGuestCapabilities(
        { uploadFiles: false, viewComments: true, agentContextContribute: true },
        { uploadFiles: true, viewComments: true, agentContextContribute: true },
      ),
    ).toEqual({ uploadFiles: false, viewComments: true, agentContextContribute: true });
  });

  it("still requires the board's own opt-in even when the instance allows it", () => {
    expect(
      combineGuestCapabilities(
        { uploadFiles: true, viewComments: true, agentContextContribute: true },
        { uploadFiles: false, viewComments: true, agentContextContribute: false },
      ),
    ).toEqual({ uploadFiles: false, viewComments: true, agentContextContribute: false });
  });

  it("grants all three only when instance and board both agree", () => {
    expect(
      combineGuestCapabilities(
        { uploadFiles: true, viewComments: true, agentContextContribute: true },
        { uploadFiles: true, viewComments: true, agentContextContribute: true },
      ),
    ).toEqual({ uploadFiles: true, viewComments: true, agentContextContribute: true });
  });

  it("keeps agent context contribution closed unless instance and board both allow it", () => {
    expect(
      combineGuestCapabilities(
        { uploadFiles: false, viewComments: true, agentContextContribute: true },
        { uploadFiles: false, viewComments: true, agentContextContribute: false },
      ),
    ).toEqual({ uploadFiles: false, viewComments: true, agentContextContribute: false });
  });
});
