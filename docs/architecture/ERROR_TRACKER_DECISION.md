# Error tracker: which one, and why now (NIL-415)

Status: target updated by NIL-626. Davi explicitly chose GlitchTip on
26.08.2026; the opt-in deployment now lives in the Compose `observability`
profile.

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

## Decision update: GlitchTip replaces Bugsink (NIL-626)

Both are MIT-licensed, Django-based, and implement the Sentry event-ingestion
protocol -- either one accepts events from the standard `@sentry/react` and
`@sentry/node` SDKs unmodified, so the SDK choice does not depend on which
server wins.

NIL-415 originally recommended Bugsink for its single-container footprint and
named GlitchTip as the protocol-compatible fallback. Davi has now exercised
that fallback because GlitchTip's dashboard is materially more useful for this
instance. This changes the deployment target, not the application integration:
both accept the Sentry wire format, so `backend/src/errorTracker.ts` and the
frontend SDK remain unchanged.

The resource objection has also changed. GlitchTip 6.2.6 does not require a
Celery/Redis service for this deployment shape. Its [official installation
guide](https://glitchtip.com/documentation/install/) documents Valkey as
optional: setting `VALKEY_URL` to the empty string uses Postgres for task queue,
cache and sessions, while `SERVER_ROLE=all_in_one` embeds the worker. The
Compose profile sets exactly that shape and includes no Redis/Valkey service.

The no-Redis shape was measured, not inferred from YAML. With swap disabled per
container, a fresh Postgres migration peaked at 140.3 MiB for GlitchTip and
51.4 MiB for Postgres. Twelve accepted backend events over twelve seconds
peaked at 172.6 MiB and 63.3 MiB. The final limits are 320 MiB + 192 MiB, so the
complete two-container profile retains Bugsink's former aggregate 512 MiB
ceiling.

Full self-hosted Sentry is not reconsidered here; nothing has changed about
the resource case against it, and NIL-415's original write-up already
covered why.

## Privacy: what must never reach the tracker

Board content, element text, file names, and raw user identifiers are
explicitly out. This is a design constraint on integration, not just an
operational promise:

- Adapter reports carry only `seam`, `code`, `fallback` and `packageVersion`;
  there is no field for board content.
- The frontend `beforeSend` hook rebuilds render-crash events instead of
  forwarding the original message or React component stack.
- The backend `beforeSend` hook rebuilds each event around a synthetic
  `BackendError` and accepts only `requestId`, `statusCode`, `method`, `code`
  and `event` as tags. Logger fields such as email, user/board ids, object keys
  and stored paths cannot cross that allowlist.
- Both SDKs set `sendDefaultPii: false`, disable default integrations and omit
  breadcrumbs. These are application guarantees independent of whether the
  Sentry endpoint is Bugsink or GlitchTip.

## Deployment boundary after NIL-626

GlitchTip and Postgres remain opt-in infrastructure. Without the
`observability` profile neither starts; without `ERROR_TRACKER_DSN` neither SDK
initializes or sends. Enabling the profile does not itself enable application
reporting.

The application-side work listed by NIL-415 was completed before this target
change. NIL-626 deliberately does not revisit it: the Sentry SDK configuration,
`sendDefaultPii: false`, disabled default integrations and the allowlist-based
`beforeSend` scrubbers are the stable boundary. The deployment runbook and
bootstrap steps live in `docs/DEPLOYMENT.md`.
