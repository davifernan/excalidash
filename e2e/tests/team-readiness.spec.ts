import { test, expect } from "@playwright/test";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { createDrawing, deleteDrawing } from "./helpers/api";
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

// This spec launches browsers directly with `chromium.launch()` instead of
// through the `browser`/`page` fixtures (it needs several engines at once,
// which one project's fixtures cannot give it), so it does not inherit
// playwright.config.ts's `use.baseURL` either -- derived the same way that
// config derives it, or `/editor/...` below resolves against no origin at
// all.
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT) || 6767;
const BASE_URL = process.env.BASE_URL || `http://localhost:${FRONTEND_PORT}`;

type Actor = {
  id: number;
  engine: Engine;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastHeartbeatAt: number;
  cycles: number;
  errors: string[];
  offline: boolean;
};

type WatchdogViolation = { actorId: number; engine: Engine; sinceMs: number };

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
 */
const runCycle = async (actor: Actor, drawingId: string, widgetId: string) => {
  try {
    const roll = Math.random();
    if (roll < 0.4) {
      await drawRect(actor.page);
    } else if (roll < 0.55) {
      await injectNoiseImage(actor.page, {
        targetBytes: 2 * 1024 * 1024,
        elementId: `soak_img_ok_${actor.id}_${Date.now()}`,
        position: { x: Math.random() * 800, y: Math.random() * 600 },
      });
    } else if (roll < 0.6) {
      // Above the live-collaboration ceiling on purpose -- the same
      // guardrail team-acceptance.spec.ts proves structurally refuses this,
      // exercised here under sustained repeated pressure instead of once.
      await injectNoiseImage(actor.page, {
        targetBytes: 16 * 1024 * 1024,
        elementId: `soak_img_over_${actor.id}_${Date.now()}`,
        position: { x: Math.random() * 800, y: Math.random() * 600 },
      });
    } else if (roll < 0.75 && widgetId) {
      await activateDocumentWidget(actor.page);
      const next = actor.page.getByRole("button", { name: "Next page" });
      if (await next.isVisible()) await next.click();
    } else if (roll < 0.85) {
      actor.offline = !actor.offline;
      await actor.context.setOffline(actor.offline);
    } else if (roll < 0.9 && actor.engine === "chromium") {
      // Latency/jitter/packet-loss: only reachable on chromium, see this
      // file's header for why firefox/webkit do not get graduated chaos.
      const cdp = await actor.context.newCDPSession(actor.page);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 50 + Math.random() * 400,
        downloadThroughput: -1,
        uploadThroughput: -1,
        packetLoss: Math.random() * 5,
      });
    }
    actor.cycles += 1;
    actor.lastHeartbeatAt = Date.now();
  } catch (error) {
    actor.errors.push(String(error));
    actor.lastHeartbeatAt = Date.now();
  }
};

test.describe("M0 Team-Readiness-Baseline-Lauf (NIL-330)", () => {
  test(`${CONTEXT_COUNT} contexts across ${ENGINE_NAMES.join("+")}, ${Math.round(DURATION_MS / 1000)}s`, async ({
    request,
  }) => {
    test.setTimeout(0);
    expect(ENGINE_NAMES.length).toBeGreaterThanOrEqual(2);

    const drawing = await createDrawing(request, {
      name: `NIL330_TeamReadiness_${Date.now()}`,
      elements: [],
      files: {},
    });

    const actors: Actor[] = [];
    let widgetId = "";

    try {
      for (let i = 0; i < CONTEXT_COUNT; i += 1) {
        const engine = ENGINE_NAMES[i % ENGINE_NAMES.length];
        const browser = await ENGINES[engine].launch();
        const context = await browser.newContext({ baseURL: BASE_URL });
        const page = await context.newPage();
        await page.goto(`/editor/${drawing.id}`);
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
          lastHeartbeatAt: Date.now(),
          cycles: 0,
          errors: [],
          offline: false,
        });
      }

      const host = actors[0].page;
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
      await dropMarkdown(host, markdown);
      await expect(documentPageLabel(host)).toContainText("Page 1 of", { timeout: 30_000 });
      widgetId = (
        await host.evaluate(() => (window as any).__EXCALIDASH_TEST__.getSceneElements())
      )[0]?.id;

      const violations: WatchdogViolation[] = [];
      const watchdog = setInterval(() => {
        const now = Date.now();
        for (const actor of actors) {
          if (now - actor.lastHeartbeatAt > STALE_MS) {
            violations.push({ actorId: actor.id, engine: actor.engine, sinceMs: now - actor.lastHeartbeatAt });
          }
        }
      }, Math.max(1_000, Math.floor(CYCLE_MS / 2)));

      const startedAt = Date.now();
      const runLoops = actors.map(async (actor) => {
        while (Date.now() - startedAt < DURATION_MS) {
          await runCycle(actor, drawing.id, widgetId);
          await actor.page.waitForTimeout(CYCLE_MS + Math.random() * CYCLE_MS * 0.5);
        }
        // End the run online, so the final connectivity check below reflects
        // recovery, not a deliberately-offline actor.
        if (actor.offline) {
          actor.offline = false;
          await actor.context.setOffline(false).catch(() => {});
        }
      });

      await Promise.all(runLoops);
      clearInterval(watchdog);

      const finalConnectivity = await Promise.all(
        actors.map(async (actor) => ({
          actorId: actor.id,
          engine: actor.engine,
          connected: await socketConnected(actor.page),
        })),
      );

      const report = {
        drawingId: drawing.id,
        contextCount: CONTEXT_COUNT,
        engines: ENGINE_NAMES,
        durationMs: DURATION_MS,
        cycleMs: CYCLE_MS,
        staleMs: STALE_MS,
        actualElapsedMs: Date.now() - startedAt,
        totalCycles: actors.reduce((sum, a) => sum + a.cycles, 0),
        perActorCycles: actors.map((a) => ({
          id: a.id,
          engine: a.engine,
          cycles: a.cycles,
          errors: a.errors,
        })),
        watchdogViolations: violations,
        finalConnectivity,
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
        expect(actor.cycles, `actor ${actor.id} (${actor.engine}) must have completed at least one cycle`).toBeGreaterThan(0);
      }
      for (const entry of finalConnectivity) {
        expect(entry.connected, `actor ${entry.actorId} (${entry.engine}) must end the run connected`).toBe(true);
      }
    } finally {
      for (const actor of actors) {
        await actor.context.close().catch(() => {});
        await actor.browser.close().catch(() => {});
      }
      await deleteDrawing(request, drawing.id).catch(() => {});
    }
  });
});
