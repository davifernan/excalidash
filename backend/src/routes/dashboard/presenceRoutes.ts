import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { getDrawingRosters } from "../../authz/roster";
import { subjectKey } from "../../authz/subjectKey";
import type { DashboardRouteDeps } from "./types";

export const MAX_IDS = 50;
const MAX_QUERY_LENGTH = 4096;
const ID_MAX_LENGTH = 200;

type PresenceResult = {
  drawingId: string;
  connectedMemberKeys: string[];
  guestCount: number;
};

/** Shared with teamPresenceRoutes.ts: same "board ids the client already has
 * on screen" trust boundary, so the same validation applies to both. */
export const parseIds = (raw: unknown): string[] | null => {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_QUERY_LENGTH) return null;
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || id.length > ID_MAX_LENGTH) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0 || ids.length > MAX_IDS) return null;
  return ids;
};

/**
 * Who is on which board, right now, for the boards the caller can see.
 *
 * The ids come from the client, which makes them a request and not a permission:
 * every one is checked against membership, and a board the caller has no claim
 * on answers exactly like a board with nobody on it and like a board that does
 * not exist. Holding a share link is not a claim -- otherwise a forwarded URL
 * would come with a view of who is working on the other side of it.
 *
 * People are named by the same opaque per-drawing key the card carries, so the
 * two can be matched without an account id ever leaving the server.
 */
export const registerPresenceRoutes = (app: express.Express, deps: DashboardRouteDeps) => {
  const { prisma, requireAuth, asyncHandler, subjectKeySecret, presences } = deps;

  const presenceRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    // Auth-disabled browsers all act through one bootstrap account, so that
    // identity cannot distinguish callers. Keep real accounts on one budget
    // and use the normalized client network for bootstrap/anonymous callers.
    keyGenerator: (req) => {
      if (req.user?.id && req.user.authCredentialType !== "bootstrap") {
        return `account:${req.user.id}`;
      }
      return `address:${ipKeyGenerator(req.ip || "") || "anonymous"}`;
    },
  });

  app.get(
    "/dashboard/presence",
    requireAuth,
    presenceRateLimiter,
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
      const empty = (drawingId: string): PresenceResult => ({
        drawingId,
        connectedMemberKeys: [],
        guestCount: 0,
      });

      const results = ids.map((drawingId) => {
        const roster = rosters.get(drawingId) || [];
        if (!roster.some((member) => member.userId === req.user!.id)) return empty(drawingId);

        const memberIds = new Set(roster.map((member) => member.userId));
        const summary = presences.summarise(drawingId);
        const connectedMemberKeys: string[] = [];
        // Someone signed in who is only here through a link is not a member of
        // this board, however real their account is. They are counted, not named.
        let guestCount = summary.guestCount;
        for (const connected of summary.members) {
          if (memberIds.has(connected.accountId)) {
            connectedMemberKeys.push(
              subjectKey(subjectKeySecret, `drawing:${drawingId}`, connected.accountId),
            );
          } else {
            guestCount += 1;
          }
        }
        return { drawingId, connectedMemberKeys, guestCount };
      });

      res.set("Cache-Control", "private, no-store");
      return res.json({ results });
    }),
  );
};
