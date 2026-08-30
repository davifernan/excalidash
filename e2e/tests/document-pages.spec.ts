import { test, expect, type Browser, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import {
  openEditor as openEditorReady,
  dropMarkdown,
  documentPageLabel as pageLabel,
  activateDocumentWidget as activateWidget,
} from "./helpers/editor";

/**
 * Paging through a document in a meeting is only useful if it happens for the
 * room. A test that watched the person clicking would pass on a widget that
 * quietly kept its page to itself, which is exactly the bug worth catching.
 */

// Long enough to be split into pages in the browser, and unmistakable per page.
const MARKDOWN = Array.from(
  { length: 60 },
  (_, i) => `## Section ${i + 1}\n\n${`Body text for section ${i + 1}. `.repeat(30)}\n`,
).join("\n");

const openEditor = (page: Page, drawingId: string) =>
  openEditorReady(page, drawingId, { settleMs: 2000 });

test("everyone in the room turns to the same page", async ({ browser, request }) => {
  const drawing = await createDrawing(request, { name: "Shared pages E2E" });

  const host = await browser.newContext();
  const hostPage = await host.newPage();
  await openEditor(hostPage, drawing.id);

  await dropMarkdown(hostPage, MARKDOWN);
  await activateWidget(hostPage);
  await expect(pageLabel(hostPage)).toContainText("Page 1 of", { timeout: 30000 });
  // Let the board carrying the new widget reach the server before anyone joins.
  await hostPage.waitForTimeout(3000);

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await openEditor(guestPage, drawing.id);
  await activateWidget(guestPage);
  await expect(pageLabel(guestPage)).toContainText("Page 1 of", { timeout: 30000 });

  await activateWidget(hostPage);
  await hostPage.getByRole("button", { name: "Next page" }).click();

  await expect(pageLabel(hostPage)).toContainText("Page 2 of", { timeout: 10000 });
  await expect(pageLabel(guestPage)).toContainText("Page 2 of", { timeout: 10000 });

  // Nobody is the presenter: whoever may edit the board may turn the page, and
  // the turn travels back the other way just as well.
  await activateWidget(guestPage);
  await guestPage.getByRole("button", { name: "Next page" }).click();
  await expect(pageLabel(guestPage)).toContainText("Page 3 of", { timeout: 10000 });
  await expect(pageLabel(hostPage)).toContainText("Page 3 of", { timeout: 10000 });

  // And the page the room is on outlives the tab that turned it: someone
  // arriving later is shown page 3, not page 1.
  const latecomer = await browser.newContext();
  const latecomerPage = await latecomer.newPage();
  await openEditor(latecomerPage, drawing.id);
  await activateWidget(latecomerPage);
  await expect(pageLabel(latecomerPage)).toContainText("Page 3 of", { timeout: 30000 });

  await host.close();
  await guest.close();
  await latecomer.close();
  await deleteDrawing(request, drawing.id);
});

const MAX_TEXT_UPLOAD_BYTES = 2 * 1024 * 1024;
const sparseLineBlock = `${"\n".repeat(19_999)}x`;
const PATHOLOGICAL_MARKDOWN = sparseLineBlock
  .repeat(Math.ceil(MAX_TEXT_UPLOAD_BYTES / sparseLineBlock.length))
  .slice(0, MAX_TEXT_UPLOAD_BYTES);

const startResponsivenessProbe = (page: Page) =>
  page.evaluate(() => {
    const state = { gaps: [] as number[], last: performance.now(), interval: 0 };
    state.interval = window.setInterval(() => {
      const now = performance.now();
      state.gaps.push(now - state.last);
      state.last = now;
    }, 10);
    (window as typeof window & { __nil269Probe?: typeof state }).__nil269Probe = state;
  });

const finishResponsivenessProbe = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const state = (
      window as typeof window & {
        __nil269Probe?: { gaps: number[]; last: number; interval: number };
      }
    ).__nil269Probe;
    if (!state) throw new Error("Responsiveness probe was not started.");
    window.clearInterval(state.interval);
    const ordered = [...state.gaps].sort((left, right) => left - right);
    return {
      samples: ordered.length,
      medianGapMs: ordered[Math.floor(ordered.length / 2)] ?? 0,
      p95GapMs: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
      maxGapMs: ordered.at(-1) ?? 0,
    };
  });

/**
 * How large a typical frame gap may be, across engines.
 *
 * These are measurements, not aspirations. NIL-697 measured p95 values from
 * 59.0 to 69.9 ms in three local pathological-document runs, while the CI
 * incident samples were below 20 ms and had only isolated maximum spikes.
 * 80 ms is deliberately above that measured local spread, yet a sustained
 * main-thread regression still lifts p95 beyond it on every trial. A separate
 * 800 ms maximum stays above the observed Chromium and Firefox runner
 * outliers but catches a single user-visible main-thread freeze. WebKit gets
 * 1,200 ms: CI measured two reproducible 905/907 ms gaps while six local
 * WebKit trials ranged from 327 to 475 ms. NIL-702 investigates that gap; the
 * wider WebKit ceiling is not evidence that a 905 ms gap is healthy.
 * Consequently, a real freeze below its engine's ceiling remains
 * indistinguishable from runner noise; a green result does not rule it out.
 */
const MAX_P95_GAP_MS = 80;
const MAX_FREEZE_GAP_MS_BY_ENGINE = {
  chromium: 800,
  firefox: 800,
  webkit: 1200,
} as const;

const maxFreezeGapMsForEngine = (engine: string): number => {
  const ceiling = MAX_FREEZE_GAP_MS_BY_ENGINE[engine as keyof typeof MAX_FREEZE_GAP_MS_BY_ENGINE];
  if (ceiling === undefined)
    throw new Error(`Unsupported browser engine for responsiveness budget: ${engine}`);
  return ceiling;
};

type ResponsivenessTrial = { samples: number; p95GapMs: number; maxGapMs: number };

/**
 * One full pathological-paste-and-measure cycle: its own drawing, its own
 * host/guest contexts, cleaned up before returning. NIL-592 runs this up to
 * three times, so it has to be exactly as isolated per attempt as the
 * single-shot version this replaced.
 */
const runResponsivenessTrial = async (
  browser: Browser,
  request: APIRequestContext,
): Promise<ResponsivenessTrial> => {
  const drawing = await createDrawing(request, { name: "Responsive document pagination E2E" });
  const host = await browser.newContext();
  const guest = await browser.newContext();
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  try {
    await Promise.all([openEditor(hostPage, drawing.id), openEditor(guestPage, drawing.id)]);

    await startResponsivenessProbe(guestPage);
    await dropMarkdown(hostPage, PATHOLOGICAL_MARKDOWN, "pathological-newlines.md");
    await expect(guestPage.locator(".text-document-widget")).toHaveCount(1, { timeout: 30_000 });
    await expect(guestPage.locator(".text-document-widget__markdown")).toBeVisible({
      timeout: 30_000,
    });
    const measurement = await finishResponsivenessProbe(guestPage);
    await activateWidget(guestPage);
    await expect(pageLabel(guestPage)).toContainText("Page 1 of", { timeout: 30_000 });
    return measurement;
  } finally {
    await host.close();
    await guest.close();
    await deleteDrawing(request, drawing.id);
  }
};

const RESPONSIVENESS_TRIALS = 3;
const RESPONSIVENESS_TRIALS_REQUIRED = 2;

const trialHasHealthyP95 = (trial: ResponsivenessTrial): boolean => trial.p95GapMs < MAX_P95_GAP_MS;

const trialHasNoFreeze = (trial: ResponsivenessTrial, maxFreezeGapMs: number): boolean =>
  trial.maxGapMs < maxFreezeGapMs;

const trialIsUnderBudget = (trial: ResponsivenessTrial, maxFreezeGapMs: number): boolean =>
  trialHasHealthyP95(trial) && trialHasNoFreeze(trial, maxFreezeGapMs);

/**
 * Two of three trials under budget, not the first sample alone (NIL-592).
 *
 * NIL-592 introduced the majority rule because a single runner outlier is
 * not a sustained responsiveness regression. NIL-697 keeps two distinct
 * signals: two healthy p95 values catch repeated degradation while tolerating
 * one noisy trial; every maximum must remain below the higher freeze ceiling
 * because p95 alone hides its worst sample. Neither may replace the other:
 * a low maximum alone measures runner jitter instead of the product.
 */
export const passesResponsivenessBudget = (
  trials: readonly ResponsivenessTrial[],
  maxFreezeGapMs = maxFreezeGapMsForEngine("chromium"),
): boolean =>
  trials.every((trial) => trialHasNoFreeze(trial, maxFreezeGapMs)) &&
  trials.filter(trialHasHealthyP95).length >= RESPONSIVENESS_TRIALS_REQUIRED;

test.describe("responsiveness budget: two of three trials, not one absolute sample (NIL-592)", () => {
  test("stays green on the actual incident measurement (509.9 ms) alongside two ordinary trials", () => {
    const trials: ResponsivenessTrial[] = [
      { samples: 40, p95GapMs: 12, maxGapMs: 509.9 },
      { samples: 41, p95GapMs: 10, maxGapMs: 480 },
      { samples: 39, p95GapMs: 11, maxGapMs: 470 },
    ];
    expect(passesResponsivenessBudget(trials)).toBe(true);
  });

  test("goes red on one freeze even when every p95 is healthy", () => {
    const trials: ResponsivenessTrial[] = [
      { samples: 40, p95GapMs: 12, maxGapMs: 900 },
      { samples: 41, p95GapMs: 10, maxGapMs: 120 },
      { samples: 39, p95GapMs: 11, maxGapMs: 130 },
    ];
    expect(passesResponsivenessBudget(trials)).toBe(false);
  });

  test("allows the measured CI WebKit gap but still rejects a larger WebKit freeze", () => {
    const ciWebKitGap: ResponsivenessTrial[] = [
      { samples: 272, p95GapMs: 46, maxGapMs: 907 },
      { samples: 254, p95GapMs: 39, maxGapMs: 905 },
    ];
    expect(passesResponsivenessBudget(ciWebKitGap, maxFreezeGapMsForEngine("webkit"))).toBe(true);
    expect(
      passesResponsivenessBudget(
        [{ samples: 250, p95GapMs: 40, maxGapMs: 1_300 }, ...ciWebKitGap],
        maxFreezeGapMsForEngine("webkit"),
      ),
    ).toBe(false);
  });

  test("goes red on a genuine regression that blocks every trial, not just one", () => {
    const trials: ResponsivenessTrial[] = [
      { samples: 40, p95GapMs: 85, maxGapMs: 520 },
      { samples: 41, p95GapMs: 83, maxGapMs: 540 },
      { samples: 39, p95GapMs: 81, maxGapMs: 515 },
    ];
    expect(passesResponsivenessBudget(trials)).toBe(false);
  });

  test("goes red when only one of three trials is under budget", () => {
    const trials: ResponsivenessTrial[] = [
      { samples: 40, p95GapMs: 12, maxGapMs: 480 },
      { samples: 41, p95GapMs: 83, maxGapMs: 540 },
      { samples: 39, p95GapMs: 81, maxGapMs: 515 },
    ];
    expect(passesResponsivenessBudget(trials)).toBe(false);
  });
});

test("a collaborator stays responsive while a pathological 2 MiB document is paginated", async ({
  browser,
  request,
}) => {
  const maxFreezeGapMs = maxFreezeGapMsForEngine(browser.browserType().name());
  const maxAllowedFails = RESPONSIVENESS_TRIALS - RESPONSIVENESS_TRIALS_REQUIRED;
  const trials: ResponsivenessTrial[] = [];
  let passes = 0;
  let fails = 0;

  // Early exit both ways: stop the moment 2 passes are in hand (the common
  // case -- most runs need only 2 of the 3 expensive trials), and stop the
  // moment a 3rd trial could no longer reach 2 passes, rather than paying
  // for a pathological 2 MiB paste-and-measure cycle that cannot change the
  // outcome.
  while (
    trials.length < RESPONSIVENESS_TRIALS &&
    passes < RESPONSIVENESS_TRIALS_REQUIRED &&
    fails <= maxAllowedFails
  ) {
    const trial = await runResponsivenessTrial(browser, request);
    trials.push(trial);
    expect(trial.samples).toBeGreaterThan(0);
    const underBudget = trialIsUnderBudget(trial, maxFreezeGapMs);
    if (underBudget) passes += 1;
    else fails += 1;
    console.log(
      `NIL-269/NIL-592 responsiveness trial ${trials.length}/${RESPONSIVENESS_TRIALS}: ` +
        `${JSON.stringify(trial)} -- ${underBudget ? "under budget" : "OVER budget"}`,
    );
  }

  expect(PATHOLOGICAL_MARKDOWN).toHaveLength(MAX_TEXT_UPLOAD_BYTES);
  expect(
    passesResponsivenessBudget(trials, maxFreezeGapMs),
    `${passes}/${trials.length} trials under budget, need ${RESPONSIVENESS_TRIALS_REQUIRED} of ` +
      `${RESPONSIVENESS_TRIALS}: ${JSON.stringify(trials)}`,
  ).toBe(true);
});
