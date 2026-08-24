import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type express from "express";

/**
 * The rate limiter shared by every presence-style read endpoint
 * (`/dashboard/presence`, `/dashboard/collections/:id/presence`,
 * `/team/presence`) -- three call sites were carrying this word-for-word
 * (Hans, PR #75) before this factory existed.
 *
 * Not worth a dedicated boundary check the way authz/adapter are: presence
 * rate limiting is a low-stakes, easily-greppable shape (one `rateLimit({`
 * call per route file), not a security invariant with a real cost when it
 * silently drifts. This factory is the cheaper fix -- reuse it for a new
 * presence-style endpoint instead of inlining another literal `rateLimit({
 * ... })` block.
 */
export const accountOrIpRateLimiter = (windowMs: number, max: number) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Auth-disabled browsers all act through one bootstrap account, so that
    // identity cannot distinguish callers. Keep real accounts on one budget
    // and use the normalized client network for bootstrap/anonymous callers.
    keyGenerator: (req: express.Request) => {
      if (req.user?.id && req.user.authCredentialType !== "bootstrap") {
        return `account:${req.user.id}`;
      }
      return `address:${ipKeyGenerator(req.ip || "") || "anonymous"}`;
    },
  });
