import { describe, expect, it, vi } from "vitest";
import {
  TEAM_ID,
  getTeam,
  getTeamMember,
  isTeamOwnerRole,
  listTeamMembers,
  teamRoleFromUserRole,
} from "./team";

const buildDb = (overrides: Record<string, any> = {}) => ({
  team: { findUnique: vi.fn().mockResolvedValue({ id: TEAM_ID, name: "Team" }) },
  user: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
  ...overrides,
});

describe("teamRoleFromUserRole / isTeamOwnerRole", () => {
  it("maps the system ADMIN role to team owner and everything else to member", () => {
    expect(teamRoleFromUserRole("ADMIN")).toBe("owner");
    expect(teamRoleFromUserRole("USER")).toBe("member");
    expect(isTeamOwnerRole(teamRoleFromUserRole("ADMIN"))).toBe(true);
    expect(isTeamOwnerRole(teamRoleFromUserRole("USER"))).toBe(false);
  });
});

describe("getTeam", () => {
  it("reads the singleton row by its fixed id", async () => {
    const db = buildDb();
    const team = await getTeam(db as any);
    expect(team).toEqual({ id: TEAM_ID, name: "Team" });
    expect(db.team.findUnique).toHaveBeenCalledWith({
      where: { id: TEAM_ID },
      select: { id: true, name: true },
    });
  });
});

describe("listTeamMembers", () => {
  it("excludes deactivated accounts", async () => {
    const db = buildDb({
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "u1", name: "Alice", email: "a@x.com", role: "USER" }]),
      },
    });
    await listTeamMembers(db as any);
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it("orders owners before members, then alphabetically within each", async () => {
    const db = buildDb({
      user: {
        findMany: vi.fn().mockResolvedValue([
          { id: "u1", name: "Zed", email: "z@x.com", role: "ADMIN" },
          { id: "u2", name: "Alice", email: "a@x.com", role: "USER" },
          { id: "u3", name: "Bob", email: "b@x.com", role: "ADMIN" },
        ]),
      },
    });

    const members = await listTeamMembers(db as any);

    expect(members.map((m) => m.userId)).toEqual(["u3", "u1", "u2"]);
    expect(members.map((m) => m.role)).toEqual(["owner", "owner", "member"]);
  });
});

describe("getTeamMember", () => {
  it("returns null for an account that is not currently active", async () => {
    const db = buildDb({
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "u1",
          name: "Alice",
          email: "a@x.com",
          role: "USER",
          isActive: false,
        }),
      },
    });

    expect(await getTeamMember(db as any, "u1")).toBeNull();
  });

  it("returns null for an account that does not exist", async () => {
    const db = buildDb({ user: { findUnique: vi.fn().mockResolvedValue(null) } });
    expect(await getTeamMember(db as any, "missing")).toBeNull();
  });

  it("returns the member's role for an active account", async () => {
    const db = buildDb({
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "u1",
          name: "Alice",
          email: "a@x.com",
          role: "ADMIN",
          isActive: true,
        }),
      },
    });

    expect(await getTeamMember(db as any, "u1")).toEqual({
      userId: "u1",
      name: "Alice",
      email: "a@x.com",
      role: "owner",
    });
  });
});
