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
 * outliers but catches a single user-visible main-thread freeze. NIL-702
 * removed WebKit's synchronous Markdown parse from the page commit: six
 * quiet-host trials then measured maximum gaps of 74-140 ms, while the
 * original implementation measured 387-684 ms locally and 905/907 ms in CI.
 * A 300 ms WebKit ceiling leaves more than 2x headroom over the repaired
 * maximum while rejecting every one of the 371-637 ms pre-fix local samples
 * as well as the original user-visible CI freeze.
 */
const MAX_P95_GAP_MS = 80;
const MAX_FREEZE_GAP_MS_BY_ENGINE = {
  chromium: 800,
  firefox: 800,
  webkit: 300,
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
    // The wrapper appears as soon as pagination commits. Wait for the actual
    // Markdown body so moving parse work behind that wrapper cannot make this
    // responsiveness test finish before the product result exists.
    await expect(guestPage.locator(".text-document-widget__markdown-content")).toBeVisible({
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

const shouldRunAnotherResponsivenessTrial = (
  trials: readonly ResponsivenessTrial[],
  passes: number,
  fails: number,
  maxFreezeGapMs: number,
): boolean =>
  trials.length < RESPONSIVENESS_TRIALS &&
  passes < RESPONSIVENESS_TRIALS_REQUIRED &&
  fails <= RESPONSIVENESS_TRIALS - RESPONSIVENESS_TRIALS_REQUIRED &&
  trials.every((trial) => trialHasNoFreeze(trial, maxFreezeGapMs));

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

  test("does not schedule a recovery trial after a terminal freeze", () => {
    const freeze: ResponsivenessTrial = { samples: 40, p95GapMs: 12, maxGapMs: 900 };
    expect(shouldRunAnotherResponsivenessTrial([freeze], 0, 1, 800)).toBe(false);
  });

  test("rejects the original WebKit freeze and accepts the repaired measurements", () => {
    const originalCiWebKitGap: ResponsivenessTrial[] = [
      { samples: 272, p95GapMs: 46, maxGapMs: 907 },
      { samples: 254, p95GapMs: 39, maxGapMs: 905 },
    ];
    const repairedWebKitGap: ResponsivenessTrial[] = [
      { samples: 272, p95GapMs: 46, maxGapMs: 140 },
      { samples: 254, p95GapMs: 39, maxGapMs: 124 },
    ];
    expect(passesResponsivenessBudget(originalCiWebKitGap, maxFreezeGapMsForEngine("webkit"))).toBe(
      false,
    );
    expect(passesResponsivenessBudget(repairedWebKitGap, maxFreezeGapMsForEngine("webkit"))).toBe(
      true,
    );
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
  const trials: ResponsivenessTrial[] = [];
  let passes = 0;
  let fails = 0;

  // p95 is recoverable by the two-of-three rule, but a freeze is terminal:
  // `passesResponsivenessBudget` rejects any trial over its engine ceiling.
  // Stop whenever either outcome is already decided rather than paginate a
  // further pathological 2 MiB document that cannot change it.
  while (shouldRunAnotherResponsivenessTrial(trials, passes, fails, maxFreezeGapMs)) {
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

test("motion evidence: a 2 MiB Markdown document renders without freezing the board", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "motion-evidence", "Evidence-only focused browser capture");
  const drawing = await createDrawing(request, { name: "Responsive Markdown evidence" });
  try {
    await openEditor(page, drawing.id);
    await startResponsivenessProbe(page);
    await dropMarkdown(page, PATHOLOGICAL_MARKDOWN, "pathological-newlines.md");
    await expect(page.locator(".text-document-widget__markdown-content")).toBeVisible({
      timeout: 30_000,
    });
    const measurement = await finishResponsivenessProbe(page);
    await activateWidget(page);
    await expect(pageLabel(page)).toContainText("Page 1 of", { timeout: 30_000 });
    expect(measurement.p95GapMs).toBeLessThan(MAX_P95_GAP_MS);
    expect(measurement.maxGapMs).toBeLessThan(300);
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
