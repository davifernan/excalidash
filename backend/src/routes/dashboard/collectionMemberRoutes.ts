import express from "express";
import { getCollectionRoster } from "../../authz/roster";
import type { MembershipLevel } from "../../authz/membership";
import { subjectKey } from "../../authz/subjectKey";
import { derivePresenceColor, toPresenceInitials } from "../../server/socketPresence";
import type { DashboardRouteDeps } from "./types";

// Typed as Record<MembershipLevel, string>, not `as const` on a partial
// literal, so the compiler rejects this file the day MembershipLevel grows a
// level this map doesn't cover -- which is exactly the gap NIL-515 found:
// "comment" existed on MembershipLevel already, nothing assigned it here, and
// a member roster looked up ROLE_BY_LEVEL[member.level] came back `undefined`
// for a level nothing in this codebase grants yet (see AGENTS.md's note on
// DrawingPermission's "comment" tier). "commenter" is a placeholder label
// only reachable once something actually grants that level.
const ROLE_BY_LEVEL: Record<MembershipLevel, string> = {
  owner: "owner",
  edit: "editor",
  view: "viewer",
  comment: "commenter",
};

/**
 * Who a collection is shared with, told to the people it is shared with.
 *
 * `/collections/:id/shares` already answers a similar question, but only for the
 * owner and with email addresses attached, because it exists to manage access.
 * This one exists to show a team who they are working with, so it carries the
 * least that a row of faces needs: a name, its initials, a colour, a role. Not
 * existing and not being a member answer the same way, so the endpoint cannot be
 * used to find out which collections exist.
 */
export const registerCollectionMemberRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  const { prisma, requireAuth, asyncHandler, subjectKeySecret } = deps;

  app.get(
    "/collections/:id/members",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (req.user.authCredentialType === "apiKey") {
        return res.status(403).json({ error: "Forbidden", message: "Not available to API keys" });
      }
      const { id } = req.params;

      const roster = await getCollectionRoster({ prisma, collectionId: id });
      if (!roster.some((member) => member.userId === req.user!.id)) {
        return res.status(404).json({ error: "Collection not found" });
      }

      res.set("Cache-Control", "private, no-store");
      return res.json({
        collectionId: id,
        totalCount: roster.length,
        members: roster.map((member) => ({
          subjectKey: subjectKey(subjectKeySecret, `collection:${id}`, member.userId),
          name: member.name,
          initials: toPresenceInitials(member.name),
          color: derivePresenceColor(member.userId),
          role: ROLE_BY_LEVEL[member.level],
          isSelf: member.userId === req.user!.id,
        })),
      });
    }),
  );
};
