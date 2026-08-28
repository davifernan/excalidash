#!/usr/bin/env node
// NIL-639: pulls the NIL330_SOAK_RESULT=<json> line team-readiness.spec.ts
// prints on stdout out of one part's captured log, sets this job's board_id
// output (only meaningful from part 1 -- later parts reuse it, unchanged),
// and writes a small per-part summary JSON that the nightly summary job
// aggregates across all four parts. Never throws: a part that crashed
// before printing its result line still needs the workflow's later "fail
// this job" step to see an explicit failure, not a script exception that
// masks it.

const fs = require("fs");
const path = require("path");

// This is also the directory _soak-part.yml's "Upload this part's soak
// artifacts" step uploads as its single `path:`, and upload-artifact@v4
// roots that upload at this directory itself -- see
// soak-artifact-layout.test.cjs, which checks this constant against that
// workflow step and against soak-nightly-aggregate.cjs's
// PART_SUMMARY_RELATIVE_PATH so the three can't drift apart silently.
const ARTIFACT_DIR_RELATIVE = path.join("e2e", "soak-artifacts");
const PART_SUMMARY_FILENAME = "part-summary.json";

function parseResultLine(logText) {
  const line = logText
    .split("\n")
    .reverse()
    .find((l) => l.includes("NIL330_SOAK_RESULT="));
  if (!line) return null;
  const marker = "NIL330_SOAK_RESULT=";
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
  } catch {
    return null;
  }
}

// Reduces the resource sampler's raw per-minute ndjson (RSS/swap/CPU-time
// samples, one line per soak-resource-sampler.cjs tick) to the few figures
// that matter for a capacity read at a glance -- the full raw samples
// themselves stay in the artifact unmodified (resource-samples.ndjson is
// uploaded alongside part-summary.json), this is not a replacement for them.
function summarizeResourceSamples(samples) {
  if (!samples || samples.length === 0) return null;
  const memUsed = samples.map((s) => s.memUsedMB).filter((v) => typeof v === "number");
  const swapUsed = samples.map((s) => s.swapUsedMB).filter((v) => typeof v === "number");
  const first = samples[0];
  const last = samples[samples.length - 1];
  const cpuBusyJiffies = (s) =>
    s.cpu ? s.cpu.userJiffies + s.cpu.niceJiffies + s.cpu.systemJiffies : null;
  const firstBusy = cpuBusyJiffies(first);
  const lastBusy = cpuBusyJiffies(last);
  return {
    sampleCount: samples.length,
    peakMemUsedMB: memUsed.length ? Math.max(...memUsed) : null,
    peakSwapUsedMB: swapUsed.length ? Math.max(...swapUsed) : null,
    firstTs: first.ts ?? null,
    lastTs: last.ts ?? null,
    // Cumulative jiffies since boot, diffed across the part -- raw CPU time
    // consumed (user+nice+system) over the sampled window, not a rate.
    cpuBusyJiffiesDelta:
      typeof firstBusy === "number" && typeof lastBusy === "number" ? lastBusy - firstBusy : null,
  };
}

function readResourceSamples(resourcesPath) {
  if (!resourcesPath) return [];
  try {
    return fs
      .readFileSync(resourcesPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildSummary(part, exitCode, resultJson, resourceSamples = []) {
  const boardId = resultJson?.drawingId || "";
  return {
    part: Number(part),
    exitCode: Number(exitCode),
    passed: Number(exitCode) === 0,
    boardId,
    cycles: resultJson
      ? (resultJson.perActorCycles ?? []).reduce((sum, a) => sum + (a.cycles ?? 0), 0)
      : null,
    actorCount: resultJson?.perActorCycles?.length ?? null,
    watchdogViolations: resultJson?.watchdogViolations?.length ?? null,
    errorCount: resultJson
      ? (resultJson.perActorCycles ?? []).reduce((sum, a) => sum + (a.errors?.length ?? 0), 0)
      : null,
    actualElapsedMs: resultJson?.actualElapsedMs ?? null,
    resources: summarizeResourceSamples(resourceSamples),
    raw: resultJson,
  };
}

function main() {
  function arg(name, fallback = null) {
    const prefix = `--${name}=`;
    const found = process.argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  }

  const logPath = arg("log");
  const part = arg("part");
  const exitCode = arg("exit-code", "1");
  const resourcesPath = arg("resources");

  const githubOutput = process.env.GITHUB_OUTPUT;
  function setOutput(name, value) {
    if (githubOutput) fs.appendFileSync(githubOutput, `${name}=${value}\n`);
  }

  let resultJson = null;
  try {
    resultJson = parseResultLine(fs.readFileSync(logPath, "utf8"));
  } catch (err) {
    console.error(`soak-nightly-extract: could not read ${logPath}: ${err.message}`);
  }

  const resourceSamples = readResourceSamples(resourcesPath);
  const summary = buildSummary(part, exitCode, resultJson, resourceSamples);
  setOutput("board_id", summary.boardId);

  const outDir = path.join(process.env.GITHUB_WORKSPACE || ".", ARTIFACT_DIR_RELATIVE);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, PART_SUMMARY_FILENAME), JSON.stringify(summary, null, 2));

  console.log(
    `soak-nightly-extract: part ${part} -- passed=${summary.passed} cycles=${summary.cycles} ` +
      `watchdogViolations=${summary.watchdogViolations} boardId=${summary.boardId || "(none found)"}`,
  );
}

if (require.main === module) main();

module.exports = {
  parseResultLine,
  buildSummary,
  summarizeResourceSamples,
  readResourceSamples,
  ARTIFACT_DIR_RELATIVE,
  PART_SUMMARY_FILENAME,
};
