# Error tracker: which one, and why now (NIL-415)

Status: decision made, not yet deployed. Deployment needs Davi's explicit
sign-off, since it means standing up new infrastructure on the shared IONOS
server -- see "What this issue is not" below.

## The question this answers

GlitchTip, Bugsink, or `@sentry/react`/`@sentry/node` pointed at a self-hosted
endpoint -- and, since all three speak the same wire protocol, the real
question is which self-hosted **server** to run. Self-hosting is not a
preference here, it is the constraint: user errors do not leave the
instance to a SaaS. Sentry's own self-hosted distribution was already ruled
out in the original NIL-415 write-up for resource reasons -- it needs Kafka,
ClickHouse, Snuba, and Redis behind Postgres, which is out of proportion for
a single-instance app.

## Why NIL-415 said "later, not now," and why that has changed

The original write-up (measured at `3f82650`) made the case that a tracker
installed then would "measure mostly silence": 88 frontend catch blocks and
82 backend `console.error` calls, none of them behind a channel a tracker
integration could hook into once, each one a separate place an SDK call
would have to be added by hand.

Recounted now, in this repo, after NIL-502/NIL-504 and the M1 adapter work
that landed since:

- **Backend has one channel.** NIL-502 built `backend/src/logger.ts`;
  NIL-504 (this session) migrated every remaining backend file to it and
  emptied `scripts/logging-boundary.cjs`'s baseline. `logger.error` now has
  **90 call sites**, all going through one function. A tracker's backend
  integration is a single change in one file, not 82 scattered ones.
- **The frontend structural channel NIL-415 was waiting on has landed.**
  `frontend/src/integrations/excalidraw/compatibility/diagnostics.ts`
  (`onDiagnostic`/`reportFailure`, from the M1 adapter work) is live and
  called from **11 adapter files**, including `fail("editor-changed", ...)`
  in `text.ts` -- exactly the "broke a seam, at a real user" signal a canary
  run cannot find by construction, because a canary only walks paths someone
  thought to write down. `AppErrorBoundary` (`frontend/src/components/
  AppErrorBoundary.tsx`, the app-shell crash net) also landed and gives every
  render crash a per-incident reference id.
- **Neither is wired to anything yet.** `onDiagnostic` has no subscriber
  outside its own test file, and `AppErrorBoundary.componentDidCatch` still
  ends in a plain `console.error`. Both channels' own file comments say this
  is deliberate ("a subscription, not an import... with nobody listening
  nothing changes"). That is the gap this decision closes -- not by wiring it
  (see "What this issue is not"), but by naming what it should be wired to.
- **What is still not centralized, and stays out of scope here:** the
  frontend's 64 raw `console.error` sites and 114 catch blocks (recounted
  today) are not behind either channel. Folding those in is a frontend
  analogue of NIL-504 -- its own follow-up, not a precondition for choosing a
  tracker. A tracker wired today captures render crashes and every adapter
  seam failure immediately; it captures the rest only as call sites migrate
  to route through `reportFailure` or an explicit report call, the same
  incremental shape NIL-504 proved works for the backend.

In short: the channel NIL-415 said to wait for now carries real signal
(`editor-changed` and its neighbors, 90 backend `logger.error` sites), so a
tracker installed today has something other than silence to show.

## Decision: Bugsink, with GlitchTip as the named fallback

Both are MIT-licensed, Django-based, and implement the Sentry event-ingestion
protocol -- either one accepts events from the standard `@sentry/react` and
`@sentry/node` SDKs unmodified, so the SDK choice does not depend on which
server wins.

**Bugsink is the primary recommendation.** It is built explicitly for this
deployment shape: single container, SQLite-friendly (this repo's own default
`DATABASE_URL` is SQLite -- see `backend/.env.example`), no required Redis or
Celery worker/beat pair. That matters concretely here, not abstractly: a
self-hosted single-instance deployment runs alongside whatever else already
occupies its host, and this repo's own history is consistent about weighing
that (asset render concurrency defaults to 1, backup jobs check free-disk
headroom before running, E2E runs are told to scope themselves and use free
ports). The same reasoning applies to a new always-on service: prefer the
option with the smaller permanent footprint when both satisfy the
requirement, rather than assume headroom that may not be there on a given
operator's box.

**GlitchTip is the named fallback**, not a rejected option. It is more
mature, has a larger community and more complete docs, and includes features
Bugsink does not (release-adjacent alerting integrations, a more built-out
UI). If Bugsink's smaller project turns out to be missing something this
instance needs once it is actually run, or its single-container simplicity
turns out to cost more in features than the resource savings are worth,
GlitchTip is the fallback with no protocol-level migration cost -- both sides
speak the same Sentry wire format, so switching servers later does not mean
re-touching every SDK call site.

Full self-hosted Sentry is not reconsidered here; nothing has changed about
the resource case against it, and NIL-415's original write-up already
covered why.

## Privacy: what must never reach the tracker

Board content, element text, file names, and raw user identifiers are
explicitly out. This is a design constraint on integration, not just an
operational promise:

- `reportFailure`'s event shape (`seam`, `code`, `fallback`,
  `packageVersion`) already excludes all of this by construction -- there is
  no field to carry board content even by accident. Any future wiring reads
  from this event, not from broader capability state.
- `AppErrorBoundary.componentDidCatch` currently logs `error` and
  `errorInfo.componentStack` -- a React component stack can include prop
  values in dev builds. Wiring this to a tracker needs an explicit
  `beforeSend`/scrubber on the client SDK, not a bare pass-through.
- The backend's `logger.error` fields are already reviewed per-callsite
  during NIL-504 (structured `fields`, not string interpolation) but were
  not reviewed for tracker-safety specifically -- a wiring PR needs a pass
  over what actually ends up in `fields` for the highest-traffic call sites
  (auth failures, S3 errors) before enabling forwarding, not after.
- Both SDKs support a `beforeSend` hook and default PII scrubbing
  (`sendDefaultPii: false` is the correct default here, not the opt-in
  default some SDK quickstarts suggest).

## What this issue is not

This is the decision and its reasoning, not the installation. Standing up
Bugsink (or GlitchTip) means a new long-running service on Davi's server,
holding real user error data -- that needs his explicit sign-off before
anything runs, the same way any new persistent infrastructure on this box
would. A follow-up implementation ticket, once approved, would need:

1. A `bugsink` (or `glitchtip`) service added to the relevant
   `docker-compose*.yml`, with its own volume.
2. A DSN-equivalent env var in both `backend/.env.example` and
   `frontend/.env.example`, undocumented/unset by default so a fresh install
   never reports anywhere until an operator opts in.
3. `backend/src/logger.ts`'s `error()` forwarding to the client SDK when the
   DSN is configured -- one change, because of NIL-504.
4. The app shell subscribing to `onDiagnostic` and wiring
   `AppErrorBoundary.componentDidCatch`, both gated the same way.
5. The `beforeSend` scrub pass named above, reviewed before either wiring
   point is turned on by default for anyone.

None of that is done by this document. This document is the answer to "which
one, and why," so that question does not get re-litigated from zero the next
time it comes up.
