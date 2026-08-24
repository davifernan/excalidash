import express from "express";
import { getDrawingRosters } from "../../authz/roster";
import { subjectKey } from "../../authz/subjectKey";
import { TEAM_SUBJECT_SCOPE } from "./team";
import { parseIds, MAX_IDS } from "./presenceRoutes";
import { accountOrIpRateLimiter } from "./presenceRateLimit";
import type { DashboardRouteDeps } from "./types";

type TeamPresenceResult = { subjectKey: string; drawingId: string };

/**
 * Which team members are on which of *these* boards, right now.
 *
 * `presenceRoutes.ts` answers "who is on this board" grouped by board;
 * `team.ts` answers "who is on the team" with `team`-scoped keys but no
 * presence. This is their intersection, grouped by person instead of by
 * board, for the Sidebar's "Team" panel (NIL-294: "Davi is currently in
 * Roadmap Q4").
 *
 * Same trust boundary as `/dashboard/presence`: the board ids come from the
 * client, not a permission, and are checked against membership one by one --
 * a board the caller cannot see contributes nothing, exactly as if nobody
 * were on it. This is deliberately narrower than "everywhere a team member
 * happens to be": it only surfaces a location the caller could already see
 * on their own dashboard, never a board outside the caller's own reach.
 *
 * One board per person: a person with two tabs open on two different boards
 * in the requested set is reported on whichever board is encountered first
 * in `ids` -- a status line, not an audit log.
 */
export const registerTeamPresenceRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  const { prisma, requireAuth, asyncHandler, subjectKeySecret, presences } = deps;

  const teamPresenceRateLimiter = accountOrIpRateLimiter(60_000, 60);

  app.get(
    "/team/presence",
    requireAuth,
    teamPresenceRateLimiter,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (req.user.authCredentialType === "apiKey") {
        return res.status(403).json({ error: "Forbidden", message: "Not available to API keys" });
      }
      const ids = parseIds(req.query.ids);
      if (!ids) {
        return res.status(400).json({
          error: "Bad request",
          message: `ids must be 1 to ${MAX_IDS} drawing ids, comma separated`,
        });
      }

      const rosters = await getDrawingRosters({ prisma, drawingIds: ids });
      const byMember = new Map<string, string>();
      for (const drawingId of ids) {
        const roster = rosters.get(drawingId) || [];
        if (!roster.some((member) => member.userId === req.user!.id)) continue;

        const summary = presences.summarise(drawingId);
        for (const connected of summary.members) {
          const key = subjectKey(subjectKeySecret, TEAM_SUBJECT_SCOPE, connected.accountId);
          if (!byMember.has(key)) byMember.set(key, drawingId);
        }
      }

      const results: TeamPresenceResult[] = Array.from(
        byMember,
        ([memberSubjectKey, drawingId]) => ({
          subjectKey: memberSubjectKey,
          drawingId,
        }),
      );

      res.set("Cache-Control", "private, no-store");
      return res.json({ results });
    }),
  );
};
