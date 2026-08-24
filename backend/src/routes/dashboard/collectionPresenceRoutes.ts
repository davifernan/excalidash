import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { getCollectionRoster } from "../../authz/roster";
import { subjectKey } from "../../authz/subjectKey";
import type { DashboardRouteDeps } from "./types";

/**
 * Who from this collection is on any of its boards, right now.
 *
 * `presenceRoutes.ts` answers "who is on this board" with keys scoped
 * `drawing:<id>`. `collectionMemberRoutes.ts` lists this collection's roster
 * with keys scoped `collection:<id>`. The two are deliberately unmatchable --
 * a `drawing:<id>` key and a `collection:<id>` key for the same person hash
 * to different values on purpose, so presence on one board can't be used to
 * recognise someone on an unrelated one (NIL-272).
 *
 * A collection-level "who's here" question needs its own answer in the
 * collection's own scope, computed server-side where the account id is still
 * available to cross both boundaries at once: every board in the collection
 * is checked against the live registry, and a connected account is kept only
 * if the collection roster already recognises it as a member -- the same
 * "holding a link is not a claim" rule `presenceRoutes.ts` applies per board.
 */
export const registerCollectionPresenceRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps,
) => {
  const { prisma, requireAuth, asyncHandler, subjectKeySecret, presences } = deps;

  const collectionPresenceRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      if (req.user?.id && req.user.authCredentialType !== "bootstrap") {
        return `account:${req.user.id}`;
      }
      return `address:${ipKeyGenerator(req.ip || "") || "anonymous"}`;
    },
  });

  app.get(
    "/dashboard/collections/:id/presence",
    requireAuth,
    collectionPresenceRateLimiter,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (req.user.authCredentialType === "apiKey") {
        return res.status(403).json({ error: "Forbidden", message: "Not available to API keys" });
      }
      const { id: collectionId } = req.params;

      const roster = await getCollectionRoster({ prisma, collectionId });
      if (!roster.some((member) => member.userId === req.user!.id)) {
        return res.status(404).json({ error: "Collection not found" });
      }

      const memberIds = new Set(roster.map((member) => member.userId));
      const boards = await prisma.drawing.findMany({
        where: { collectionId },
        select: { id: true },
      });

      const connectedAccountIds = new Set<string>();
      let guestCount = 0;
      for (const board of boards) {
        const summary = presences.summarise(board.id);
        for (const connected of summary.members) {
          if (memberIds.has(connected.accountId)) {
            connectedAccountIds.add(connected.accountId);
          } else {
            // Signed in, but not a member of this collection -- counted like
            // presenceRoutes.ts counts one, not named like one.
            guestCount += 1;
          }
        }
        guestCount += summary.guestCount;
      }

      const connectedMemberKeys = Array.from(connectedAccountIds, (accountId) =>
        subjectKey(subjectKeySecret, `collection:${collectionId}`, accountId),
      );

      res.set("Cache-Control", "private, no-store");
      return res.json({ collectionId, connectedMemberKeys, guestCount });
    }),
  );
};
