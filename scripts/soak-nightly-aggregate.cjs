#!/usr/bin/env node
// NIL-639: reads all four parts' part-summary.json (written by
// soak-nightly-extract.cjs, downloaded by the nightly workflow's summary
// job into /tmp/soak-results/soak-part-<N>-results/soak-artifacts/), builds
// this run's aggregate, appends it as one line to the durable evidence-branch
// log, and reports median/p95 only once that log holds at least three
// same-profile rows -- SOAK_RUNNER_DECISION.md's own rule: a single run is a
// data point, not a metric, and this repo's earlier measurements already
// mixed at least two different modes (a passed run and an aborted one) when
// someone tried to average them anyway.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Overridable so soak-evidence-write.test.cjs can point this at a temp dir
// instead of the real /tmp/soak-results the workflow always uses.
const RESULTS_DIR = process.env.SOAK_RESULTS_DIR || "/tmp/soak-results";
const EVIDENCE_PATH = "soak-nightly/team-readiness-log.ndjson";

function sameProfile(a, b) {
  return (
    a.context_count === b.context_count &&
    a.engines === b.engines &&
    a.part_duration_minutes === b.part_duration_minutes
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

// max() over whichever parts actually reported a peak -- a missing part
// (readPartSummary found no file) has no `resources` field at all, and
// should not silently read as "0 MB used" against the parts that did report.
function peakAcrossParts(parts, field) {
  const values = parts.map((p) => p.resources?.[field]).filter((v) => typeof v === "number");
  return values.length ? Math.max(...values) : null;
}

function buildAggregate(parts, profile, { ts, sha, runUrl }) {
  const allPassed = parts.every((p) => p.passed === true);
  const totalCycles = parts.reduce((sum, p) => sum + (p.cycles ?? 0), 0);
  const totalWatchdogViolations = parts.reduce((sum, p) => sum + (p.watchdogViolations ?? 0), 0);
  const totalErrors = parts.reduce((sum, p) => sum + (p.errorCount ?? 0), 0);
  const totalElapsedMs = parts.reduce((sum, p) => sum + (p.actualElapsedMs ?? 0), 0);
  const peakMemUsedMB = peakAcrossParts(parts, "peakMemUsedMB");
  const peakSwapUsedMB = peakAcrossParts(parts, "peakSwapUsedMB");
  return {
    ts,
    sha,
    runUrl,
    profile,
    allPassed,
    totalCycles,
    totalWatchdogViolations,
    totalErrors,
    totalElapsedMs,
    peakMemUsedMB,
    peakSwapUsedMB,
    parts: parts.map((p) => ({
      part: p.part,
      passed: p.passed,
      missing: p.missing ?? false,
      cycles: p.cycles ?? null,
      watchdogViolations: p.watchdogViolations ?? null,
      errorCount: p.errorCount ?? null,
      actualElapsedMs: p.actualElapsedMs ?? null,
      resources: p.resources ?? null,
    })),
  };
}

// Only counts a same-profile run once it PASSED -- an aborted/failed run's
// numbers describe how far it got before something broke, not steady-state
// behavior, and mixing the two is exactly the "at least two modes" mistake
// SOAK_RUNNER_DECISION.md's own header warns against.
function matchingPassedRuns(existingRuns, profile, thisRun) {
  const priorMatches = existingRuns.filter(
    (r) => r && sameProfile(r.profile, profile) && r.allPassed,
  );
  return thisRun.allPassed ? [...priorMatches, thisRun] : priorMatches;
}

function metricsSection(matching, profile) {
  if (matching.length < 3) {
    return [
      `Not enough same-profile passed runs yet for median/p95: ${matching.length} of the required 3` +
        ` (context_count=${profile.context_count}, engines=${profile.engines}, part_duration_minutes=${profile.part_duration_minutes}).`,
      "No metric reported -- per SOAK_RUNNER_DECISION.md, a single run (or fewer than three same-profile runs) is a data point, not a metric.",
    ];
  }
  const durations = matching.map((r) => r.totalElapsedMs).filter((v) => typeof v === "number");
  const cycles = matching.map((r) => r.totalCycles).filter((v) => typeof v === "number");
  return [
    `Median/p95 across ${matching.length} same-profile passed runs (context_count=${profile.context_count}, engines=${profile.engines}, part_duration_minutes=${profile.part_duration_minutes}):`,
    `- total elapsed: median ${Math.round(median(durations) / 1000)}s, p95 ${Math.round(p95(durations) / 1000)}s`,
    `- total cycles: median ${Math.round(median(cycles))}, p95 ${Math.round(p95(cycles))}`,
  ];
}

// evidenceWriteError, when present, means this run's raw numbers were NOT
// durably recorded -- see the PUT in main(). That must show up in both
// places a human (or soak-nightly-notify.cjs, which embeds this whole
// string in the tracking-issue comment) would look: the Overall verdict
// itself, not just a buried extra line, and an explicit line naming the
// failure. Hans-Friedrich finding on #223: the four parts all passing and
// the evidence write failing must never read as a clean PASSED.
function buildSummaryMarkdown(thisRun, parts, metricsLines, evidenceWriteError = null) {
  const overallPassed = thisRun.allPassed && !evidenceWriteError;
  return [
    `# Nightly team-readiness soak -- ${thisRun.ts}`,
    "",
    `Overall: ${overallPassed ? "PASSED" : "FAILED"}`,
    evidenceWriteError
      ? `Evidence log write: FAILED -- ${evidenceWriteError.message.split("\n")[0]} (this run's raw numbers were NOT durably recorded)`
      : "Evidence log write: appended",
    `Profile: context_count=${thisRun.profile.context_count}, engines=${thisRun.profile.engines}, part_duration_minutes=${thisRun.profile.part_duration_minutes}`,
    `Total cycles: ${thisRun.totalCycles} · Watchdog violations: ${thisRun.totalWatchdogViolations} · Actor errors: ${thisRun.totalErrors} · Elapsed: ${Math.round(thisRun.totalElapsedMs / 1000)}s`,
    `Peak RSS: ${thisRun.peakMemUsedMB ?? "n/a"} MB · Peak swap: ${thisRun.peakSwapUsedMB ?? "n/a"} MB (raw per-part samples: soak-part-<N>-results/resource-samples.ndjson)`,
    "",
    "## Per part",
    ...parts.map(
      (p) =>
        `- Part ${p.part}: ${p.missing ? "MISSING" : p.passed ? "passed" : "FAILED"}` +
        (p.missing
          ? ""
          : `, cycles=${p.cycles}, watchdogViolations=${p.watchdogViolations}, errors=${p.errorCount}`),
    ),
    "",
    "## Median/p95",
    ...metricsLines,
  ].join("\n");
}

// Relative to the downloaded artifact's own directory
// (<RESULTS_DIR>/soak-part-<N>-results/). upload-artifact@v4 roots a
// single-directory `path:` at that directory itself -- see
// _soak-part.yml's "Upload this part's soak artifacts" step and
// soak-artifact-layout.test.cjs, which models the rule against both files
// so a future change to either can't drift silently again.
const PART_SUMMARY_RELATIVE_PATH = "part-summary.json";

function main() {
  function readPartSummary(part) {
    const p = path.join(RESULTS_DIR, `soak-part-${part}-results`, PART_SUMMARY_RELATIVE_PATH);
    if (!fs.existsSync(p)) return { part, missing: true, passed: false };
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  function gh(args) {
    return execFileSync("gh", args, { encoding: "utf8" });
  }

  const parts = [1, 2, 3, 4].map(readPartSummary);
  const profile = {
    context_count: process.env.CONTEXT_COUNT || null,
    engines: process.env.ENGINES || null,
    part_duration_minutes: process.env.PART_DURATION_MINUTES || null,
  };
  const thisRun = buildAggregate(parts, profile, {
    ts: new Date().toISOString(),
    sha: process.env.GITHUB_SHA || null,
    runUrl: process.env.RUN_URL || null,
  });

  // Append-only: fetch current content (if any), append this run, write
  // back. The `evidence` branch is the repo's established durable,
  // never-force-pushed home for exactly this kind of append-only record
  // (see excalidash-kickoffs/_common.md, "Bildnachweise: PR und dauerhafter
  // evidence-Branch").
  let existingLines = [];
  let existingSha = null;
  try {
    const contentJson = gh([
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/contents/${EVIDENCE_PATH}?ref=evidence`,
    ]);
    const parsed = JSON.parse(contentJson);
    existingSha = parsed.sha;
    existingLines = Buffer.from(parsed.content, "base64")
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    console.log(
      `soak-nightly-aggregate: no existing evidence log yet (${err.message.split("\n")[0]}) -- starting one`,
    );
  }

  const newLines = [...existingLines, JSON.stringify(thisRun)];
  const newContentB64 = Buffer.from(newLines.join("\n") + "\n", "utf8").toString("base64");
  const body = {
    message: `soak: append nightly team-readiness run ${thisRun.ts}`,
    content: newContentB64,
    branch: "evidence",
    ...(existingSha ? { sha: existingSha } : {}),
  };
  fs.writeFileSync("/tmp/soak-evidence-put-body.json", JSON.stringify(body));
  // Hans-Friedrich finding on #223: this PUT is the entire point of the
  // nightly run -- NIL-639 asks for a durable, growing record, not a
  // pass/fail. A 403 (missing `contents: write`, see this workflow's
  // permissions: block) or any other failure here used to be swallowed --
  // logged, never surfaced -- so the step stayed green while the evidence
  // log silently never grew. It must fail the step instead: caught here
  // only to finish writing summary.md for the next step (the tracking-issue
  // comment still needs to fire even on a failed write), then re-raised
  // after that so the process exits non-zero.
  let evidenceWriteError = null;
  try {
    gh([
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/contents/${EVIDENCE_PATH}`,
      "--input",
      "/tmp/soak-evidence-put-body.json",
      "-X",
      "PUT",
    ]);
    console.log("soak-nightly-aggregate: appended this run to evidence branch log");
  } catch (err) {
    evidenceWriteError = err;
    console.error(`soak-nightly-aggregate: failed to write evidence log: ${err.message}`);
  }

  const existingRuns = existingLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const matching = matchingPassedRuns(existingRuns, profile, thisRun);
  const summaryMd = buildSummaryMarkdown(
    thisRun,
    parts,
    metricsSection(matching, profile),
    evidenceWriteError,
  );

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, "summary.md"), summaryMd);
  console.log(summaryMd);

  if (evidenceWriteError) {
    console.error(
      "soak-nightly-aggregate: exiting non-zero -- the evidence-branch write failed, " +
        "see the error above. summary.md and the tracking-issue comment still went out, " +
        "but this run's raw numbers were NOT durably recorded.",
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  sameProfile,
  median,
  p95,
  buildAggregate,
  matchingPassedRuns,
  metricsSection,
  buildSummaryMarkdown,
  PART_SUMMARY_RELATIVE_PATH,
};
