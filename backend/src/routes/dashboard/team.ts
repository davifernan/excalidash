import express from "express";
import { getTeam, listTeamMembers } from "../../authz/team";
import { subjectKey } from "../../authz/subjectKey";
import { DashboardRouteDeps } from "./types";

/** Exported so tests can prove this scope actually differs from others -- not just that a key comes back. */
export const TEAM_SUBJECT_SCOPE = "team";

/**
 * The team roster. Reads only, and deliberately small: this is the seam
 * NIL-323's Team Home and Canvas Shell chrome (M2.2) build on, not a settings
 * surface -- there is nothing here yet to change (see authz/team.ts for why
 * there is no separate role to assign).
 */
export const registerTeamRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  const { prisma, requireAuth, asyncHandler, subjectKeySecret } = deps;

  app.get(
    "/team",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const [team, members] = await Promise.all([getTeam(prisma), listTeamMembers(prisma)]);
      return res.json({
        name: team?.name ?? "Team",
        // Named fields, not a spread of the authz projection: a roster shown
        // to every teammate is not the place account ids or email addresses
        // travel by accident -- same reasoning, and the same subjectKey
        // mechanism, as authz/roster.ts's RosterMember and drawingMembers.ts.
        members: members.map((member) => ({
          subjectKey: subjectKey(subjectKeySecret, TEAM_SUBJECT_SCOPE, member.userId),
          name: member.name,
          role: member.role,
          isSelf: member.userId === req.user!.id,
        })),
      });
    }),
  );
};
