import { test, expect } from "@playwright/test";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDrawing, deleteDrawing, API_URL } from "./helpers/api";
import {
  dropMarkdown,
  documentPageLabel,
  activateDocumentWidget,
  injectNoiseImage,
} from "./helpers/editor";

/**
 * NIL-330's "Verbindlicher Team-Readiness-Baseline-Lauf" -- an operator-
 * triggered soak, not a per-PR gate (see playwright.config.ts's SOAK_SPECS
 * comment for why it is isolated the way REAL_AUTH_SPECS is, and its own
 * `soak` project, invoked only with `--project=soak`).
 *
 * ## What this answers, and how, honestly
 *
 * The question this package's KICKOFF names directly: "what does this check
 * do when it cannot tell?" A soak that reports green on a timeout without
 * ever having actually observed the room working is worse than no soak --
 * see this file's `WatchdogViolation` handling and the final assertions,
 * which fail CLOSED. Silence from any one context (a crash, a hang, a
 * connection that never came back) fails the whole run; it is never averaged
 * away against the contexts that stayed healthy.
 *
 * ## What is actually implemented here, against the full mandated profile
 *
 * Implemented:
 *   - N concurrent browser contexts (SOAK_CONTEXT_COUNT, default 10) on one
 *     board, split across at least two real engines (SOAK_ENGINES, default
 *     chromium+firefox; webkit opt-in via env -- see below).
 *   - A configurable-duration run (SOAK_DURATION_MS, default 8h) of repeated
 *     draw / select / shared-page-switch / image / save / reconnect cycles
 *     per context.
 *   - Synthetic images at the same size boundaries team-acceptance.spec.ts
 *     (NIL-330's integrated acceptance test) exercises: comfortably-small,
 *     and above the live-collaboration ceiling.
 *   - Network chaos via `context.setOffline` (binary, works identically on
 *     every engine) on a randomized schedule per context, plus CDP
 *     `Network.emulateNetworkConditions` (latency/jitter/packet-loss) on
 *     chromium contexts specifically, where Playwright actually exposes it.
 *   - A watchdog that fails the run the moment any context's heartbeat goes
 *     stale, not just at the end.
 *   - A per-actor heartbeat timeseries and a server-side `/health` timeseries
 *     (code + latency, once a second, for the whole run), written to disk as
 *     an artifact even when the watchdog trips (NIL-321). Before this, the
 *     watchdog's own error message was the only evidence of a stall, and it
 *     names exactly one actor -- whether the other nine kept working or also
 *     went quiet was structurally unobservable. See "Reading the artifact"
 *     below.
 *   - Bounded data isolation across the ten contexts (NIL-321): only
 *     SOAK_SHARED_WRITERS actors (default 2) share the collaborative board
 *     NIL-330 mandates ("mindestens zwei konkurrierende Schreiber", page-
 *     switch convergence); every other actor gets its own drawing, created
 *     the same way. Full per-context isolation (all ten on separate boards)
 *     would drop the shared-board requirement entirely, and separate SQLite
 *     databases per context are not warranted here: `/health` was measured
 *     healthy (12ms median, p95 57ms) at the exact moment an actor went
 *     silent, so DB-wide contention was already the least likely explanation
 *     going into this cut -- see NIL-321's kickoff. Reducing eight of ten
 *     actors' writes to their own row is enough to rule out the same-row
 *     lock-contention reading of that hypothesis without touching the
 *     mandated collaboration path or paying for N separate databases.
 *
 * ## Reading the artifact
 *
 * Every run (pass, fail, or watchdog trip) writes `SOAK_ARTIFACT_DIR`
 * (default `<e2e>/soak-artifacts/<runId>/`):
 *   - `actor-heartbeats.csv`   -- ts,actorId,engine,boardId,cycle,step (one
 *     row per completed cycle, per actor; a gap in one actor's rows near the
 *     end while others keep rows coming is exactly "did the room stall, or
 *     just this one actor" made visible without re-running anything).
 *   - `server-health.csv`     -- ts,code,latencyMs, once a second for the
 *     whole run (same shape as the health-poller.sh pattern this reuses).
 *   - `report.json`           -- the full structured report (also printed as
 *     `NIL330_SOAK_RESULT=...` to stdout, unchanged from before).
 *   - `page-switch-traces.json` -- every page_switch attempt's button
 *     position samples, whether it moved, and (for a timed-out attempt) what
 *     `document.elementFromPoint` found there instead -- see `PageSwitchTrace`
 *     and "Does page_switch move or get covered?" below.
 *   - `summary.txt`           -- plain-text roll-up: per-actor cycle counts
 *     and last-heartbeat age, watchdog violations, server-health code
 *     distribution, and one line per timed-out page_switch attempt. Readable
 *     without opening a CSV/JSON viewer.
 *
 * ## What "last step" does NOT tell you (NIL-330, 2026-08-25 quiet-machine run)
 *
 * `actor-heartbeats.csv` and `lastStep` only ever record a *completed* cycle.
 * A watchdog trip means the actor is mid-cycle, in whichever step it started
 * and never finished -- `lastStep` at that point still names the PREVIOUS,
 * already-finished step, not the one it is stuck in. On a quiet host (load
 * 0.07, no other agent running) a real run measured exactly this gap: actor 6
 * went silent for 45311ms with `lastStep: "image_ok"` -- true, but stale; the
 * hang was in whatever step ran *after* that one, which the old artifact had
 * no way to name.
 *
 * `Actor.inFlightStep` closes that gap: set the moment a step is chosen, BEFORE
 * its action runs, and cleared back to `null` only once that action finishes
 * (success or caught error). A watchdog violation now captures
 * `inFlightStep` at the instant it fires, and the final artifact's per-actor
 * summary shows it too -- a stuck actor is the one row still showing a
 * non-null in-flight step long after its last heartbeat, naming the exact
 * step, not just the fact of silence. See `SOAK_HANG_STEP` below for how this
 * is proven, not just asserted.
 *
 * ## Does page_switch move or get covered? (NIL-330, 2026-08-25)
 *
 * `inFlightStep` named the culprit: three independent runs (this file's own
 * PR #157 control run plus two quiet-machine diagnostic runs) all stuck in
 * `page_switch`. The cause was `if (await next.isVisible()) await
 * next.click();` with no `actionTimeout` -- Playwright's default is
 * unbounded, so a "Next page" button that moved or got covered between the
 * `isVisible()` snapshot and the click's own actionability wait hung
 * forever (NIL-524: waiting with no bound is not a test). `clickPageSwitchButton`
 * bounds it (`PAGE_SWITCH_CLICK_TIMEOUT_MS`) and, per NIL-330's own
 * instruction not to assume which of two hypotheses before measuring, traces
 * the button's position while waiting: NIL-565 put page navigation in a
 * floating toolbar that follows the active element, and NIL-573 made that
 * toolbar dodge obstacles -- a repositioning button reads as "not stable"
 * to Playwright's actionability check the same way a genuinely blocked one
 * does, and only a position trace tells the two apart. `moved: true` in
 * `page-switch-traces.json` means the toolbar itself is the mechanism;
 * `moved: false` with a non-null `coveredBy` means something else sits on
 * top of a button that never left. See `PageSwitchTrace` and
 * `clickPageSwitchButton` for exactly what is sampled and when.
 *
 * ## Bounded is not the same as correct (NIL-330, follow-up)
 *
 * The bound above turned an infinite hang into a 5s failure, but every one of
 * those failures was still real: 30 of 39 measured page_switch attempts timed
 * out, all 39 with `moved: false`, on a button that was never covered either.
 * The actual cause is `isVisible()` itself. `TextDocumentWidget.tsx` and
 * `PdfWidget.tsx` render "Next page" with `disabled={pending || pageIndex ===
 * pageCount - 1}` -- disabled, not unmounted, on the last page. `isVisible()`
 * is true for a disabled-but-rendered button, so the old precheck always
 * passed there and `click()`'s own actionability wait then blocked forever on
 * a control that was never going to become clickable. `isEnabled()` is the
 * actual precondition. On its own that still leaves a second failure mode:
 * once every actor has walked to the last page, `page_switch` becomes a
 * permanent no-op that exercises nothing. `performStep` below occasionally
 * pages backward for exactly that reason -- see its own comment.
 *
 * NOT implemented, named rather than silently skipped (this package's
 * HANDOFF names these as the exact remaining gap against the mandated
 * profile, not a claim of having met it):
 *   - Real curated smartphone photos with EXIF rotation. This uses generated
 *     noise images at the mandated size boundaries (2/14/15MB-plus), which
 *     exercises the same client-side size guardrail and packet-splitting
 *     path a real photo would, but not decode/orientation behavior specific
 *     to real camera output or unsupported-format rejection.
 *   - Latency/jitter/packet-loss chaos on firefox/webkit specifically:
 *     Playwright's CDP session is chromium-only, so those two engines only
 *     get the offline/online toggle, not graduated network degradation.
 *   - A genuinely unattended multi-hour execution: this file makes an
 *     8-hour default run possible and correct, but this package's own PR
 *     evidence is a short, explicitly-labeled smoke invocation
 *     (SOAK_DURATION_MS set low) proving the harness and its fail-closed
 *     watchdog actually work, not a completed 8-hour baseline. Running the
 *     full mandated profile is a separate operator action -- see this
 *     package's HANDOFF for the exact command.
 *
 * ## Running it
 *
 *   cd e2e
 *   PORT=<free> FRONTEND_PORT=<free> \
 *     npx playwright test --project=soak team-readiness
 *
 * Env vars (all optional):
 *   SOAK_CONTEXT_COUNT   default 10
 *   SOAK_DURATION_MS     default 28800000 (8h)
 *   SOAK_CYCLE_MS        default 15000 -- how often each context acts
 *   SOAK_STALE_MS        default 3x SOAK_CYCLE_MS -- watchdog threshold
 *   SOAK_ENGINES         default "chromium,firefox" -- comma-separated,
 *                        any of chromium/firefox/webkit
 *   SOAK_SHARED_WRITERS  default 2 -- actors sharing the one collaborative
 *                        board; the rest each get their own drawing
 *   SOAK_ARTIFACT_DIR    default "soak-artifacts" (relative to e2e/) -- where
 *                        the heartbeat/health timeseries artifact is written
 *   SOAK_HANG_ACTOR_ID   unset by default -- if set, that actor index goes
 *                        silent forever instead of continuing, to prove the
 *                        artifact and watchdog both see one actor stall
 *                        while the rest keep going (the NIL-321 evidence
 *                        run; see this package's HANDOFF). Without
 *                        SOAK_HANG_STEP: hangs on the cycle after its first
 *                        real one, in whatever step that cycle's own random
 *                        roll picks -- proving inFlightStep names it even
 *                        though nobody chose it in advance. With
 *                        SOAK_HANG_STEP: hangs on its very first cycle,
 *                        forced into exactly that named step -- proving
 *                        inFlightStep names a specific, predetermined step
 *                        (the NIL-330 Nachweispflicht for this cut).
 *   SOAK_HANG_STEP       unset by default -- one of draw / image_ok /
 *                        image_over / page_switch / offline_toggle /
 *                        network_chaos. Only meaningful together with
 *                        SOAK_HANG_ACTOR_ID; see above.
 *   SOAK_PAGE_SWITCH_CLICK_TIMEOUT_MS  default 5000 -- bound on the "Next
 *                        page" click specifically (see "Does page_switch
 *                        move or get covered?" above).
 */

type Engine = "chromium" | "firefox" | "webkit";

const ENGINES: Record<Engine, typeof chromium> = { chromium, firefox, webkit };

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CONTEXT_COUNT = envInt("SOAK_CONTEXT_COUNT", 10);
const DURATION_MS = envInt("SOAK_DURATION_MS", 8 * 60 * 60 * 1000);
const CYCLE_MS = envInt("SOAK_CYCLE_MS", 15_000);
const STALE_MS = envInt("SOAK_STALE_MS", CYCLE_MS * 3);
const ENGINE_NAMES = (process.env.SOAK_ENGINES || "chromium,firefox")
  .split(",")
  .map((name) => name.trim())
  .filter((name): name is Engine => name === "chromium" || name === "firefox" || name === "webkit");
const SHARED_WRITER_COUNT = Math.min(envInt("SOAK_SHARED_WRITERS", 2), CONTEXT_COUNT);
const HANG_ACTOR_ID = process.env.SOAK_HANG_ACTOR_ID
  ? Number.parseInt(process.env.SOAK_HANG_ACTOR_ID, 10)
  : null;
const HANG_STEP = process.env.SOAK_HANG_STEP || null;
const HANG_PAGE_SWITCH_PHASE = process.env.SOAK_HANG_PAGE_SWITCH_PHASE || null;
const PAGE_SWITCH_HANG_PHASES = new Set(["activate_document_widget"]);
if (HANG_PAGE_SWITCH_PHASE && !PAGE_SWITCH_HANG_PHASES.has(HANG_PAGE_SWITCH_PHASE)) {
  throw new Error(`SOAK_HANG_PAGE_SWITCH_PHASE must be one of ${[...PAGE_SWITCH_HANG_PHASES].join(", ")}.`);
}
const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const ARTIFACT_DIR = join(process.cwd(), process.env.SOAK_ARTIFACT_DIR || "soak-artifacts", RUN_ID);
// NIL-639: a GitHub-hosted job cannot run this spec's own 8h default in one
// piece (GitHub's 6h hard job ceiling -- see docs/architecture/
// SOAK_RUNNER_DECISION.md). The nightly workflow instead chains several
// shorter jobs against the SAME shared board, so the scene this spec grows
// keeps accumulating across parts even though each part is a fresh process.
// Both are no-ops for a normal manual run: unset, this spec creates and
// deletes its own board exactly as before.
const EXISTING_BOARD_ID = process.env.SOAK_EXISTING_BOARD_ID || null;
const SKIP_TEARDOWN = process.env.SOAK_SKIP_TEARDOWN === "true";

// This spec launches browsers directly with `chromium.launch()` instead of
// through the `browser`/`page` fixtures (it needs several engines at once,
// which one project's fixtures cannot give it), so it does not inherit
// playwright.config.ts's `use.baseURL` either -- derived the same way that
// config derives it, or `/editor/...` below resolves against no origin at
// all.
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT) || 6767;
const BASE_URL = process.env.BASE_URL || `http://localhost:${FRONTEND_PORT}`;

type HeartbeatEntry = {
  ts: number;
  actorId: number;
  engine: Engine;
  boardId: string;
  cycle: number;
  step: string;
};

type Actor = {
  id: number;
  engine: Engine;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Drawing this actor acts on -- the shared board for the first
   * SHARED_WRITER_COUNT actors, an own isolated drawing for the rest. */
  boardId: string;
  widgetId: string;
  lastHeartbeatAt: number;
  /** The most recently COMPLETED step. Stale the instant a new cycle starts
   * -- see `inFlightStep` for what is running right now. */
  lastStep: string;
  /** The step chosen for the cycle currently running, set before its action
   * executes and cleared to null once it finishes (success or caught error).
   * NIL-330: a watchdog violation that only had `lastStep` named the last
   * thing that finished, never the thing the actor is actually stuck in --
   * this is what a stuck actor's row is still holding when the artifact is
   * written. See this file's header, "What 'last step' does NOT tell you". */
  inFlightStep: string | null;
  /** Set when this actor's loop has run its course. A finished actor stops
   * sending heartbeats, which is not the same as going silent. */
  finished: boolean;
  cycles: number;
  errors: string[];
  offline: boolean;
  /** Timeseries evidence for NIL-321: does silence from one actor mean the
   * room stalled, or just this one? Written to the artifact even when the
   * watchdog trips -- see this file's header, "Reading the artifact". */
  heartbeats: HeartbeatEntry[];
  /** NIL-330: where the "Next page" button actually was during every
   * page_switch attempt, and what happened. See `PageSwitchTrace`. */
  pageSwitchTraces: PageSwitchTrace[];
};

/** One position sample of the "Next page" button, taken while a page_switch
 * click is being attempted. `null` box means the button was not found at
 * that instant (already gone, or never appeared). */
type ButtonSample = {
  t: number;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
};

/**
 * NIL-330's own diagnostic ask: does the "Next page" button move during the
 * wait (the NIL-565/NIL-573 floating toolbar that follows the element and
 * dodges obstacles), or does it stay put while something else sits on top of
 * it? `moved` and `coveredBy` are measured, not assumed -- see `performStep`'s
 * page_switch case for how each is derived.
 */
type PageSwitchTrace = {
  actorId: number;
  ts: number;
  /** Written before the first browser operation, so a non-returning call is
   * evidence rather than an absent trace. */
  phase: "activate_document_widget" | "button_enabled" | "click" | "complete";
  outcome: "started" | "clicked" | "not_visible" | "timeout" | "error";
  samples: ButtonSample[];
  /** True when the first and last position samples differ by more than a
   * few pixels -- the button relocated while we were waiting on it. */
  moved: boolean;
  /** Only populated when `outcome === "timeout"`: what
   * `document.elementFromPoint` found at the button's last known centre --
   * `null` if the button itself (or one of its own children, e.g. its icon
   * glyph -- that is the button rendering itself, not an obstruction) was
   * still the topmost hit target there, meaning the click failed for some
   * other actionability reason (measured in practice: `disabled` -- see this
   * file's own header), a short description of whatever else was on top
   * otherwise. */
  coveredBy: string | null;
};

type WatchdogViolation = {
  actorId: number;
  engine: Engine;
  sinceMs: number;
  /** The step the actor was in the middle of when this violation fired --
   * NIL-330's actual ask: not just that it stalled, but where. */
  inFlightStep: string | null;
};
type ServerHealthEntry = { ts: number; code: number; latencyMs: number };

const FINAL_CHECK_TIMEOUT_MS = envInt("SOAK_FINAL_CHECK_TIMEOUT_MS", 30_000);

/**
 * Bound for the page_switch "Next page" click specifically (NIL-330).
 *
 * Neither this file's own `timeout` (the whole test's budget, 0 for the soak
 * project -- deliberately unbounded for an 8h run) nor Playwright's global
 * `expect.timeout` cover a bare `locator.click()`: `actionTimeout` has no
 * default, so an unset one is unbounded (NIL-524 -- waiting with no bound is
 * not a test). `if (await next.isVisible()) await next.click()` checked
 * visibility once and then clicked with no bound at all: a target that moved
 * or got covered between that snapshot and the click's own actionability
 * wait hung forever, which is exactly the stall NIL-330 measured three times
 * (this file's own control run in PR #157, plus two quiet-machine diagnostic
 * runs, all three stuck in this step). Bounded here so the same failure
 * becomes a caught, recorded error instead of invisible silence.
 */
const PAGE_SWITCH_CLICK_TIMEOUT_MS = envInt("SOAK_PAGE_SWITCH_CLICK_TIMEOUT_MS", 5_000);
// Diagnostic, not a performance budget: normal activation is milliseconds;
// eight seconds leaves deliberately generous headroom while naming a hang.
const PAGE_SWITCH_PHASE_TIMEOUT_MS = envInt("SOAK_PAGE_SWITCH_PHASE_TIMEOUT_MS", 8_000);

/**
 * Bounds a promise that has no timeout of its own.
 *
 * `page.evaluate(...).catch(() => false)` handles a *rejection* -- a closed
 * page, a thrown error. It does not handle the page simply never answering,
 * because a hang is an absence, not an error. After the action phase the
 * watchdog is already off, so an unanswered evaluate there waits forever with
 * nobody watching: measured on 2026-08-25 as 83 minutes of a live process at
 * 0% CPU, no backend traffic, no output, no exit (NIL-563).
 *
 * Rejecting rather than resolving to a default is deliberate. "The page did
 * not answer" and "the socket is not connected" are different verdicts, and
 * folding the first into the second would turn a broken run into a clean
 * failed assertion -- which reads as a product problem that isn't there.
 */
const withDeadline = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${what} did not answer within ${ms} ms. The page is unresponsive; ` +
            `this is not the same as "not connected".`,
        ),
      );
    }, ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

const socketConnected = (page: Page): Promise<boolean> =>
  page
    .evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true)
    .catch(() => false);

const drawRect = (page: Page) =>
  page.evaluate(() => {
    const api = (window as any).__EXCALIDASH_TEST__;
    if (!api) throw new Error("Missing __EXCALIDASH_TEST__");
    const id = `soak_rect_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    api.updateScene({
      elements: [
        ...api.getSceneElementsIncludingDeleted(),
        {
          id,
          type: "rectangle",
          x: Math.random() * 1000,
          y: Math.random() * 600,
          width: 80 + Math.random() * 120,
          height: 60 + Math.random() * 80,
          angle: 0,
          strokeColor: "#1e1e1e",
          backgroundColor: "#a5d8ff",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          seed: Math.floor(Math.random() * 1e9),
          version: 1,
          versionNonce: Math.floor(Math.random() * 1e9),
          isDeleted: false,
          boundElements: null,
          updated: Date.now(),
          link: null,
          locked: false,
        },
      ],
    });
  });

/**
 * Which step a cycle would take, decided before anything runs.
 *
 * Split out from execution (see `performStep`) specifically so `runCycle` can
 * record `actor.inFlightStep` BEFORE the action starts, not after it
 * finishes -- see this file's header, "What 'last step' does NOT tell you".
 * Reads `actor.widgetId`/`actor.engine` (real state) but has no side effects
 * of its own; the roll is the only randomness.
 */
const decideStep = (actor: Actor, roll: number): string => {
  if (actor.id === HANG_ACTOR_ID && HANG_PAGE_SWITCH_PHASE) return "page_switch";
  if (roll < 0.4) return "draw";
  if (roll < 0.55) return "image_ok";
  // Above the live-collaboration ceiling on purpose -- the same guardrail
  // team-acceptance.spec.ts proves structurally refuses this, exercised here
  // under sustained repeated pressure instead of once.
  if (roll < 0.6) return "image_over";
  if (roll < 0.75 && actor.widgetId) return "page_switch";
  if (roll < 0.85) return "offline_toggle";
  // Latency/jitter/packet-loss: only reachable on chromium, see this file's
  // header for why firefox/webkit do not get graduated chaos.
  if (roll < 0.9 && actor.engine === "chromium") return "network_chaos";
  return "none";
};

/**
 * Attempts the "Next page"/"Previous page" click with a bound
 * (`PAGE_SWITCH_CLICK_TIMEOUT_MS`) and a position trace, per NIL-330's own
 * diagnostic ask: does the button move while we wait on it (the
 * NIL-565/NIL-573 floating toolbar, which
 * follows the active element and dodges obstacles), or does it hold still
 * while something else sits on top of it? Measured here, not assumed.
 *
 * Sampling runs concurrently with the bounded click via `setInterval` --
 * the click's own actionability wait is opaque from the outside, so this is
 * the only way to see where the button actually was during it, including on
 * the timeout path where the click itself never tells us.
 */
const clickPageSwitchButton = async (actor: Actor, next: Locator, trace: PageSwitchTrace): Promise<void> => {
  const samples: ButtonSample[] = [];
  const startedAt = Date.now();
  const sample = async () => {
    const box = await next.boundingBox().catch(() => null);
    samples.push({
      t: Date.now() - startedAt,
      x: box?.x ?? null,
      y: box?.y ?? null,
      width: box?.width ?? null,
      height: box?.height ?? null,
    });
  };

  await sample();
  const poll = setInterval(() => {
    void sample();
  }, 300);

  let outcome: PageSwitchTrace["outcome"] = "clicked";
  let coveredBy: string | null = null;
  try {
    await next.click({ timeout: PAGE_SWITCH_CLICK_TIMEOUT_MS });
  } catch (error) {
    outcome = "timeout";
    clearInterval(poll);
    await sample();
    const last = samples[samples.length - 1];
    if (last?.x !== null && last?.y !== null && last?.width !== null && last?.height !== null) {
      const cx = last.x! + last.width! / 2;
      const cy = last.y! + last.height! / 2;
      const handle = await next.elementHandle().catch(() => null);
      if (handle) {
        coveredBy = await actor.page
          .evaluate(
            ([el, x, y]) => {
              const top = document.elementFromPoint(x, y);
              if (!top) return "nothing (offscreen or empty at that point)";
              // The button's own icon glyph (an inner <svg>/<path>) is
              // legitimately the topmost hit at its own centre -- that is
              // not an obstruction, it is the button rendering itself.
              // `contains` is true for the element itself too, so this one
              // check covers both "it's the button" and "it's the button's
              // own child".
              if (el.contains(top)) return null;
              const cls = (top.getAttribute("class") || "").slice(0, 80);
              return `<${top.tagName.toLowerCase()} class="${cls}">`;
            },
            [handle, cx, cy] as const,
          )
          .catch(() => "unknown (elementFromPoint check itself failed)");
      }
    }
    throw error;
  } finally {
    clearInterval(poll);
    const first = samples[0];
    const last = samples[samples.length - 1];
    const moved =
      !!first &&
      !!last &&
      first.x !== null &&
      last.x !== null &&
      (Math.abs(first.x! - last.x!) > 2 || Math.abs(first.y! - last.y!) > 2);
    trace.outcome = outcome;
    trace.samples = samples;
    trace.moved = moved;
    trace.coveredBy = coveredBy;
    trace.phase = "complete";
  }
};

/** Executes one already-decided step's real action. Every action either
 * succeeds or throws -- see `runCycle`'s own comment for why none of these
 * swallow their own errors. */
const performStep = async (actor: Actor, step: string): Promise<void> => {
  switch (step) {
    case "draw":
      await drawRect(actor.page);
      break;
    case "image_ok":
      await injectNoiseImage(actor.page, {
        targetBytes: 2 * 1024 * 1024,
        elementId: `soak_img_ok_${actor.id}_${Date.now()}`,
        position: { x: Math.random() * 800, y: Math.random() * 600 },
      });
      break;
    case "image_over":
      await injectNoiseImage(actor.page, {
        targetBytes: 16 * 1024 * 1024,
        elementId: `soak_img_over_${actor.id}_${Date.now()}`,
        position: { x: Math.random() * 800, y: Math.random() * 600 },
      });
      break;
    case "page_switch": {
      const trace: PageSwitchTrace = {
        actorId: actor.id,
        ts: Date.now(),
        phase: "activate_document_widget",
        outcome: "started",
        samples: [],
        moved: false,
        coveredBy: null,
      };
      actor.pageSwitchTraces.push(trace);
      const enterPhase = async (phase: PageSwitchTrace["phase"]) => {
        trace.phase = phase;
      };
      await enterPhase("activate_document_widget");
      try {
        await activateDocumentWidget(actor.page, {
          timeout: PAGE_SWITCH_PHASE_TIMEOUT_MS,
          blockActivation: actor.id === HANG_ACTOR_ID && HANG_PAGE_SWITCH_PHASE === "activate_document_widget",
        });
      // Paging backward sometimes, not just forward: both buttons stay
      // mounted (disabled, not hidden) at either end of the document, so an
      // actor that only ever goes forward eventually parks on the last page
      // and this step turns into a permanent no-op that tests nothing
      // (NIL-330 follow-up). 20% backward is enough to keep actors cycling
      // through the interior of a multi-page document instead of draining
      // to one end and staying there.
      const goBack = Math.random() < 0.2;
      const button = actor.page.getByRole("button", {
        name: goBack ? "Previous page" : "Next page",
      });
      // isEnabled(), not isVisible(): the button renders on every page --
      // disabled, never unmounted -- at the start/end of the document
      // (TextDocumentWidget.tsx, PdfWidget.tsx). isVisible() is true for a
      // disabled button too, so the precheck was passing right into the
      // actionability wait it was meant to avoid. See this file's header,
      // "Bounded is not the same as correct".
        await enterPhase("button_enabled");
        const enabled = await button.isEnabled({ timeout: PAGE_SWITCH_PHASE_TIMEOUT_MS });
        if (!enabled) {
          trace.outcome = "not_visible";
          trace.phase = "complete";
          break;
        }
        await enterPhase("click");
        await clickPageSwitchButton(actor, button, trace);
      } catch (error) {
        // clickPageSwitchButton records its own timeout and obstruction data
        // before rethrowing. Keep that richer terminal outcome intact.
        if (trace.outcome === "started") trace.outcome = "error";
        throw error;
      }
      break;
    }
    case "offline_toggle":
      actor.offline = !actor.offline;
      await actor.context.setOffline(actor.offline);
      break;
    case "network_chaos": {
      const cdp = await actor.context.newCDPSession(actor.page);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 50 + Math.random() * 400,
        downloadThroughput: -1,
        uploadThroughput: -1,
        packetLoss: Math.random() * 5,
      });
      break;
    }
    case "none":
      break;
  }
};

/**
 * One actor's action cycle.
 *
 * Fail-closed, per a Hans-Friedrich finding on this file (NIL-499, PR #76):
 * every branch used to swallow its own errors (`.catch(() => {})` on
 * injectImage/drawRect, on the widget click, on setOffline, inside the CDP
 * try/catch), which made the try/catch around this whole function pure
 * decoration -- nothing ever reached it, so a real action failure (the
 * harness gone, a page crashed, a genuine exception) was silently treated as
 * a successful cycle and the soak could report green having actually
 * observed nothing. That is exactly the failure mode this file's own header
 * and KICKOFF.md's soak guidance both name directly.
 *
 * The decision, now visible in code rather than accidental: these are all
 * scripted actions against our own harness, not user-facing network
 * conditions the harness is supposed to tolerate (the offline/online toggle
 * IS the induced condition; the *call* to `setOffline` itself has no
 * legitimate reason to fail). So nothing here swallows -- every action
 * either succeeds or throws, the one try/catch below is the only error
 * boundary, and a caught error is counted in `actor.errors` and evaluated at
 * the end (see the zero-tolerance assertion after the run loop) rather than
 * discarded. A cycle that throws still updates the heartbeat: the actor
 * itself is not silent, it hit a real, now-recorded problem -- silence
 * (no heartbeat at all for STALE_MS) is a separate, watchdog-caught failure.
 *
 * `actor.inFlightStep` is set to the chosen step BEFORE `performStep` runs
 * (NIL-330) -- if this step hangs, that is exactly the value a watchdog
 * violation or the final artifact will see, not the previous, already-
 * finished step `lastStep` still names. Cleared back to `null` once the step
 * actually finishes, success or caught error alike.
 */
const runCycle = async (actor: Actor) => {
  // NIL-330 Nachweispflicht hook: with SOAK_HANG_STEP set, force that exact
  // step on this actor's very first cycle attempt (deterministic, no need to
  // wait for the random roll to land on it). Without it, HANG_ACTOR_ID keeps
  // the NIL-321 behaviour -- complete one real cycle, then hang on whatever
  // step the second cycle's own roll happens to choose, proving inFlightStep
  // names a step nobody predetermined too.
  const forcedHangStep =
    actor.id === HANG_ACTOR_ID && HANG_STEP && actor.cycles === 0 ? HANG_STEP : null;
  const step = forcedHangStep ?? decideStep(actor, Math.random());
  actor.inFlightStep = step;

  const shouldHang =
    actor.id === HANG_ACTOR_ID && !HANG_PAGE_SWITCH_PHASE &&
    (forcedHangStep !== null || (!HANG_STEP && actor.cycles >= 1));

  try {
    if (shouldHang) {
      // Never resolves -- the watchdog is the only thing that ends the run.
      // inFlightStep above is already set to the real step name; that is the
      // entire point of this hook.
      await new Promise<never>(() => {});
    }
    await performStep(actor, step);
    actor.cycles += 1;
    actor.lastStep = step;
    actor.inFlightStep = null;
    actor.lastHeartbeatAt = Date.now();
    actor.heartbeats.push({
      ts: actor.lastHeartbeatAt,
      actorId: actor.id,
      engine: actor.engine,
      boardId: actor.boardId,
      cycle: actor.cycles,
      step,
    });
  } catch (error) {
    actor.errors.push(String(error));
    actor.lastStep = `${step}_error`;
    actor.inFlightStep = null;
    actor.lastHeartbeatAt = Date.now();
    actor.heartbeats.push({
      ts: actor.lastHeartbeatAt,
      actorId: actor.id,
      engine: actor.engine,
      boardId: actor.boardId,
      cycle: actor.cycles,
      step: actor.lastStep,
    });
  }
};

/** Server-side evidence for the same "one actor or all of them?" question
 * (see this file's header): polls `/health` once a second for the whole run
 * and keeps recording after the watchdog trips, same shape as the
 * health-poller.sh pattern this reuses. */
const startServerHealthPoll = (apiUrl: string, entries: ServerHealthEntry[]) => {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now();
    let code = 0;
    try {
      const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      code = res.status;
    } catch {
      code = 0;
    }
    entries.push({ ts: Date.now(), code, latencyMs: Date.now() - t0 });
  };
  const timer = setInterval(tick, 1_000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

/** Drops the same markdown fixture host setup used and returns the
 * resulting document widget's element id, for one board. Called once per
 * unique board (the shared board, and each isolated actor's own board) so
 * every actor's page-switch step has something to switch. */
const setupBoardWidget = async (page: Page): Promise<string> => {
  // Same shape document-pages.spec.ts's own (proven) MARKDOWN constant
  // uses: enough distinct body text per section to actually split into
  // multiple pages, not just render as one long single page. The nested
  // template -- `.repeat` on the inner body string, not the whole
  // section -- matters: applying it to the outer string instead
  // duplicates the heading into the body and produces far less real
  // content per byte, which was this file's first smoke-test failure.
  const markdown = Array.from(
    { length: 60 },
    (_, i) => `## Section ${i + 1}\n\n${`Soak body ${i + 1}. `.repeat(30)}\n`,
  ).join("\n");
  await dropMarkdown(page, markdown);
  await activateDocumentWidget(page);
  await expect(documentPageLabel(page)).toContainText("Page 1 of", { timeout: 30_000 });
  return (await page.evaluate(() => (window as any).__EXCALIDASH_TEST__.getSceneElements()))[0]?.id;
};

const csvEscape = (value: string) =>
  /[,"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const writeArtifact = (params: {
  actors: Actor[];
  serverHealth: ServerHealthEntry[];
  violations: WatchdogViolation[];
  report: Record<string, unknown>;
}) => {
  const { actors, serverHealth, violations, report } = params;
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const heartbeatRows = ["ts,actorId,engine,boardId,cycle,step"];
  for (const actor of actors) {
    for (const hb of actor.heartbeats) {
      heartbeatRows.push(
        [hb.ts, hb.actorId, hb.engine, csvEscape(hb.boardId), hb.cycle, csvEscape(hb.step)].join(
          ",",
        ),
      );
    }
  }
  writeFileSync(join(ARTIFACT_DIR, "actor-heartbeats.csv"), heartbeatRows.join("\n") + "\n");

  const healthRows = [
    "ts,code,latencyMs",
    ...serverHealth.map((h) => `${h.ts},${h.code},${h.latencyMs}`),
  ];
  writeFileSync(join(ARTIFACT_DIR, "server-health.csv"), healthRows.join("\n") + "\n");

  writeFileSync(join(ARTIFACT_DIR, "report.json"), JSON.stringify(report, null, 2));

  const pageSwitchTraces = actors.flatMap((a) => a.pageSwitchTraces);
  writeFileSync(
    join(ARTIFACT_DIR, "page-switch-traces.json"),
    JSON.stringify(pageSwitchTraces, null, 2),
  );

  const now = Date.now();
  const healthCodeCounts = serverHealth.reduce<Record<string, number>>((acc, h) => {
    acc[h.code] = (acc[h.code] || 0) + 1;
    return acc;
  }, {});
  const summaryLines = [
    `NIL-330 soak run ${RUN_ID}`,
    `contexts=${actors.length} engines=${ENGINE_NAMES.join("+")} sharedWriters=${SHARED_WRITER_COUNT}`,
    `watchdog violations: ${
      violations.length === 0
        ? "none"
        : violations
            .map(
              (v) =>
                `actor ${v.actorId} (${v.engine}) silent ${v.sinceMs}ms, stuck in step "${v.inFlightStep ?? "unknown"}"`,
            )
            .join("; ")
    }`,
    "",
    "per-actor:",
    ...actors.map(
      (a) =>
        `  actor ${a.id} (${a.engine}, board=${a.boardId === actors[0].boardId ? "shared" : "isolated"}): ` +
        `${a.cycles} cycles, last completed step "${a.lastStep}" ${Math.round((now - a.lastHeartbeatAt) / 1000)}s ago, ` +
        `in-flight step: ${a.inFlightStep === null ? "none (idle between cycles)" : `"${a.inFlightStep}"`}, ${a.errors.length} errors`,
    ),
    "",
    `server /health: ${serverHealth.length} samples, codes=${JSON.stringify(healthCodeCounts)}`,
  ];

  const timedOutTraces = pageSwitchTraces.filter((t) => t.outcome === "timeout");
  summaryLines.push(
    "",
    `page_switch traces: ${pageSwitchTraces.length} attempts, ${timedOutTraces.length} timed out ` +
      "(full samples in page-switch-traces.json)",
    ...timedOutTraces.map(
      (t) =>
        `  actor ${t.actorId} @ ${new Date(t.ts).toISOString()}: moved=${t.moved}, ` +
        `coveredBy=${t.coveredBy === null ? "nothing (button itself was still topmost)" : t.coveredBy}, ` +
        `${t.samples.length} position samples`,
    ),
  );
  writeFileSync(join(ARTIFACT_DIR, "summary.txt"), summaryLines.join("\n") + "\n");

  console.log(`NIL330_SOAK_ARTIFACT_DIR=${ARTIFACT_DIR}`);
};

test.describe("M0 Team-Readiness-Baseline-Lauf (NIL-330)", () => {
  test(`${CONTEXT_COUNT} contexts across ${ENGINE_NAMES.join("+")}, ${Math.round(DURATION_MS / 1000)}s`, async ({
    request,
  }) => {
    test.setTimeout(0);
    expect(ENGINE_NAMES.length).toBeGreaterThanOrEqual(2);

    const drawing = EXISTING_BOARD_ID
      ? { id: EXISTING_BOARD_ID }
      : await createDrawing(request, {
          name: `NIL330_TeamReadiness_${Date.now()}`,
          elements: [],
          files: {},
        });

    const actors: Actor[] = [];
    const serverHealth: ServerHealthEntry[] = [];
    const violations: WatchdogViolation[] = [];
    let stopHealthPoll: (() => void) | null = null;
    let report: Record<string, unknown> = { runId: RUN_ID, sharedBoardId: drawing.id };

    try {
      stopHealthPoll = startServerHealthPoll(API_URL, serverHealth);

      for (let i = 0; i < CONTEXT_COUNT; i += 1) {
        const engine = ENGINE_NAMES[i % ENGINE_NAMES.length];
        const browser = await ENGINES[engine].launch();
        const context = await browser.newContext({ baseURL: BASE_URL });
        const page = await context.newPage();
        // See this file's header, "isolation is bounded": only the first
        // SHARED_WRITER_COUNT actors share `drawing` -- the rest each get
        // their own isolated board, created the same way.
        const boardId =
          i < SHARED_WRITER_COUNT
            ? drawing.id
            : (
                await createDrawing(request, {
                  name: `NIL330_TeamReadiness_${Date.now()}_actor${i}`,
                  elements: [],
                  files: {},
                })
              ).id;
        await page.goto(`/editor/${boardId}`);
        await page.waitForSelector("canvas", { timeout: 30_000 });
        await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__, undefined, {
          timeout: 30_000,
        });
        await page.waitForTimeout(1_000);
        actors.push({
          id: i,
          engine,
          browser,
          context,
          page,
          boardId,
          widgetId: "",
          lastHeartbeatAt: Date.now(),
          lastStep: "setup",
          inFlightStep: null,
          finished: false,
          cycles: 0,
          errors: [],
          offline: false,
          heartbeats: [],
          pageSwitchTraces: [],
        });
      }

      // One document-widget setup per unique board: the shared board once
      // (for every shared-writer actor), then once per isolated actor's own
      // board, so every actor's page-switch step has something to switch.
      const widgetByBoard = new Map<string, string>();
      for (const actor of actors) {
        let widgetId = widgetByBoard.get(actor.boardId);
        if (widgetId === undefined) {
          widgetId = await setupBoardWidget(actor.page);
          widgetByBoard.set(actor.boardId, widgetId);
        }
        actor.widgetId = widgetId;
      }

      // Setup (context launch, then one widget drop per unique board,
      // sequential) can itself take longer than STALE_MS once isolation
      // multiplies the widget setup across several boards -- every actor's
      // `lastHeartbeatAt` was stamped when its context was created, not when
      // setup as a whole finished, so the watchdog (started below) could
      // trip on setup latency it was never meant to measure. Reset here,
      // once, right before the clock that matters starts.
      for (const actor of actors) {
        actor.lastHeartbeatAt = Date.now();
      }

      // The watchdog has to be able to END the run, not just describe it.
      //
      // It used to only push into `violations`, which is read after
      // `await Promise.all(runLoops)`. If one actor's cycle hangs -- an
      // evaluate against a page whose main thread is blocked, say -- that
      // actor's loop never resolves, `Promise.all` never returns, and the
      // interval keeps appending to an array nobody will ever read. Measured
      // on 2026-08-25: activity stopped 97s into a 45s run, then 5m23s of
      // total silence, and only an external `timeout` ended it (NIL-563).
      //
      // A guard that observes but cannot act is not fail-closed. For an
      // unattended eight-hour run it is worse than none, because its presence
      // is the reason nobody watches.
      let tripWatchdog: (error: Error) => void = () => {};
      const watchdogTripped = new Promise<never>((_, reject) => {
        tripWatchdog = reject;
      });
      let tripped = false;
      const watchdog = setInterval(
        () => {
          const now = Date.now();
          for (const actor of actors) {
            if (actor.finished) continue;
            if (now - actor.lastHeartbeatAt > STALE_MS) {
              const activePageSwitch = [...actor.pageSwitchTraces]
                .reverse()
                .find((trace) => trace.outcome === "started");
              // An unfinished trace is more precise than the outer step. It
              // exists only while page_switch is in flight, so prefer it.
              const diagnosticStep = actor.inFlightStep === "page_switch" && activePageSwitch
                ? `page_switch.${activePageSwitch.phase}`
                : actor.inFlightStep ?? "unknown";
              violations.push({
                actorId: actor.id,
                engine: actor.engine,
                sinceMs: now - actor.lastHeartbeatAt,
                inFlightStep: diagnosticStep,
              });
              if (!tripped) {
                tripped = true;
                tripWatchdog(
                  new Error(
                    `actor ${actor.id} (${actor.engine}) went silent for ` +
                      `${now - actor.lastHeartbeatAt} ms, over the ${STALE_MS} ms threshold, ` +
                      `stuck in step "${diagnosticStep}". ` +
                      `Ending the run instead of waiting for a cycle that may never finish.`,
                  ),
                );
              }
            }
          }
        },
        Math.max(1_000, Math.floor(CYCLE_MS / 2)),
      );

      const startedAt = Date.now();
      const runLoops = actors.map(async (actor) => {
        // NIL-321/NIL-330 evidence run: HANG_ACTOR_ID's hang itself now lives
        // inside `runCycle` (see its own comment), because it has to set
        // `inFlightStep` to the real step name before hanging in it -- that
        // is the whole point of this hook. This loop does not special-case
        // it at all; the actor's own runCycle call below decides.
        while (Date.now() - startedAt < DURATION_MS) {
          await runCycle(actor);
          await actor.page.waitForTimeout(CYCLE_MS + Math.random() * CYCLE_MS * 0.5);
          // The pause between cycles is by design, not a symptom. Without this
          // heartbeat it counted against STALE_MS, which left far less headroom
          // than the threshold suggests:
          //
          //   STALE_MS  = 3 x CYCLE_MS            = 45_000 ms
          //   the wait  = CYCLE_MS x 1.0 .. 1.5   = up to 22_500 ms
          //   left for one actual cycle             22_500 ms
          //
          // So any cycle slower than 1.5x CYCLE_MS tripped a false alarm.
          // Measured under ten concurrent contexts: five actors at once showed
          // 43-46 s gaps while sitting at cycles=0 or 1 -- none of them stuck,
          // all of them merely mid-cycle (NIL-563).
          actor.lastHeartbeatAt = Date.now();
        }
        // End the run online, so the final connectivity check below reflects
        // recovery, not a deliberately-offline actor.
        if (actor.offline) {
          actor.offline = false;
          await actor.context.setOffline(false).catch(() => {});
        }
        // Actors do not all cross the finish line at the same moment: whoever
        // is mid-cycle when DURATION_MS elapses keeps going until that cycle
        // ends. Until this flag existed, an actor that had legitimately
        // finished simply stopped sending heartbeats -- and the watchdog,
        // which runs until *every* loop resolves, read that as going silent.
        // Measured: an instrumented run showed no cycle step over 5 s, yet
        // reported a 51 s silence. That silence was the finish-line spread,
        // not a hang (NIL-563).
        actor.finished = true;
      });

      // Raced, not awaited: a stuck loop must lose to the watchdog rather than
      // outlast it. `runLoops` keep running after a trip, but the `finally`
      // below closes their contexts, which ends them.
      try {
        await Promise.race([Promise.all(runLoops), watchdogTripped]);
      } finally {
        clearInterval(watchdog);
      }

      // Bounded on purpose: the watchdog was just cleared, so nothing else is
      // watching from here on. An unresponsive page must end the run with a
      // readable reason instead of parking it forever (NIL-563).
      const finalConnectivity = await Promise.all(
        actors.map(async (actor) => ({
          actorId: actor.id,
          engine: actor.engine,
          connected: await withDeadline(
            socketConnected(actor.page),
            FINAL_CHECK_TIMEOUT_MS,
            `final connectivity check for actor ${actor.id} (${actor.engine})`,
          ),
        })),
      );

      report = {
        runId: RUN_ID,
        drawingId: drawing.id,
        contextCount: CONTEXT_COUNT,
        sharedWriterCount: SHARED_WRITER_COUNT,
        engines: ENGINE_NAMES,
        durationMs: DURATION_MS,
        cycleMs: CYCLE_MS,
        staleMs: STALE_MS,
        actualElapsedMs: Date.now() - startedAt,
        totalCycles: actors.reduce((sum, a) => sum + a.cycles, 0),
        perActorCycles: actors.map((a) => ({
          id: a.id,
          engine: a.engine,
          boardId: a.boardId,
          cycles: a.cycles,
          lastStep: a.lastStep,
          inFlightStep: a.inFlightStep,
          errors: a.errors,
        })),
        watchdogViolations: violations,
        finalConnectivity,
        serverHealthSamples: serverHealth.length,
      };
      console.log(`NIL330_SOAK_RESULT=${JSON.stringify(report)}`);

      // Fail-closed: every one of these is a distinct way the run could have
      // gone quiet without anyone noticing, and none of them is waived just
      // because the others passed.
      expect(violations, "no context may go silent for longer than SOAK_STALE_MS").toEqual([]);
      const actorsWithErrors = actors.filter((a) => a.errors.length > 0);
      expect(
        actorsWithErrors.map((a) => ({ id: a.id, engine: a.engine, errors: a.errors })),
        "no scripted action may fail during the soak -- these are our own harness calls, not user-facing conditions the harness tolerates; a failure here is a real bug, not chaos",
      ).toEqual([]);
      for (const actor of actors) {
        expect(
          actor.cycles,
          `actor ${actor.id} (${actor.engine}) must have completed at least one cycle`,
        ).toBeGreaterThan(0);
      }
      for (const entry of finalConnectivity) {
        expect(
          entry.connected,
          `actor ${entry.actorId} (${entry.engine}) must end the run connected`,
        ).toBe(true);
      }
    } finally {
      // The artifact is written here -- before teardown, after everything
      // that can still throw above -- so it exists whether the run passed,
      // failed its assertions, or the watchdog tripped and raced the try
      // block to a rejection. This is the one thing NIL-321 actually asked
      // for: evidence that survives the exact moment the run goes wrong.
      stopHealthPoll?.();
      // A watchdog trip rejects `Promise.race` before the full report below
      // is ever assigned, which used to leave report.json holding only its
      // initial `{runId, sharedBoardId}` stub on exactly the runs where the
      // full picture matters most. Fill it in from whatever is available if
      // the try block above never got that far.
      if (!("perActorCycles" in report)) {
        report = {
          ...report,
          contextCount: CONTEXT_COUNT,
          sharedWriterCount: SHARED_WRITER_COUNT,
          engines: ENGINE_NAMES,
          durationMs: DURATION_MS,
          cycleMs: CYCLE_MS,
          staleMs: STALE_MS,
          incomplete: true,
          perActorCycles: actors.map((a) => ({
            id: a.id,
            engine: a.engine,
            boardId: a.boardId,
            cycles: a.cycles,
            lastStep: a.lastStep,
            inFlightStep: a.inFlightStep,
            errors: a.errors,
          })),
          watchdogViolations: violations,
        };
      }
      writeArtifact({ actors, serverHealth, violations, report });

      // Teardown is bounded for the same reason: a browser that will not close
      // must not hold an unattended eight-hour run open indefinitely. Failures
      // here are swallowed -- the run's verdict was already decided above, and
      // a stuck close should not overwrite it.
      for (const actor of actors) {
        await withDeadline(
          actor.context.close(),
          FINAL_CHECK_TIMEOUT_MS,
          `context close for actor ${actor.id}`,
        ).catch(() => {});
        await withDeadline(
          actor.browser.close(),
          FINAL_CHECK_TIMEOUT_MS,
          `browser close for actor ${actor.id}`,
        ).catch(() => {});
      }
      // SKIP_TEARDOWN protects only the shared board across parts (it is the
      // continuity artifact restored by the next part) -- an isolated actor's
      // own board is never reused by any later part, in this run or the next
      // one, so it is deleted every time regardless of SKIP_TEARDOWN.
      if (!SKIP_TEARDOWN) {
        await deleteDrawing(request, drawing.id).catch(() => {});
      }
      for (const actor of actors) {
        if (actor.boardId !== drawing.id) {
          await deleteDrawing(request, actor.boardId).catch(() => {});
        }
      }
    }
  });
});
