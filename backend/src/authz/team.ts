import type { AuthzDb } from "./client";

/**
 * The team, and who is on it.
 *
 * ExcaliDash is built for one team of about ten people per self-hosted
 * install, not for multi-tenant workspaces (explicit non-goal -- see
 * docs/product/PRODUCT_VISION.md). So `Team` is a singleton: one row, fixed
 * id, seeded by the migration that created the table.
 *
 * Membership is not a second table. An account IS a team member for exactly
 * as long as `User.isActive` says so -- that flag is already the single,
 * carefully-guarded authority for "can this account currently act" (see
 * `countActiveAdmins`, offboarding, socket revocation). A `TeamMembership`
 * row that merely mirrored it would be a second copy of that fact, which is
 * the precise failure this codebase already paid for once: `ACCESS_RANK`
 * lived in three files before NIL-487 collapsed it into one, and the
 * forgotten copies silently sorted an unknown grant level as no access.
 *
 * Team role is `User.role` ("ADMIN" | "USER"), read through the vocabulary
 * below rather than duplicated. "ADMIN" already carries real authority here
 * (impersonation, user management, must-keep-one invariant via
 * `countActiveAdmins`) -- that authority IS what "team owner" means, so
 * `TeamRole` names it instead of introducing a second, independently
 * assignable role that the two would need to be kept in sync by hand.
 *
 * Open contract gap, deliberately not filled here: this module has no
 * single-member lookup (a `getTeamMember(userId)`) and no `isTeamOwnerRole`
 * predicate -- an earlier version had both, but neither had a caller
 * anywhere outside this file's own tests (Hans-Friedrich, PR #58). Adding
 * them back requires a real consumer, not a guess at one; the first package
 * that needs "is this specific account a team owner" (a per-member role
 * badge, a gate on a team-management action) should add it here, next to
 * `listTeamMembers`, not build its own copy.
 */

export const TEAM_ID = "default";

export type TeamRole = "owner" | "member";

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
};

export const teamRoleFromUserRole = (userRole: string): TeamRole =>
  userRole === "ADMIN" ? "owner" : "member";

/** The team row. Always present -- seeded by the migration that created the table. */
export const getTeam = async (db: AuthzDb): Promise<{ id: string; name: string } | null> =>
  db.team.findUnique({ where: { id: TEAM_ID }, select: { id: true, name: true } });

/** Every current member, owners first, then alphabetically by name. */
export const listTeamMembers = async (db: AuthzDb): Promise<TeamMember[]> => {
  const users = await db.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });
  const members = users.map((user): TeamMember => ({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: teamRoleFromUserRole(user.role),
  }));
  return members.sort((a, b) => {
    if (a.role === b.role) return a.name.localeCompare(b.name);
    return a.role === "owner" ? -1 : 1;
  });
};
