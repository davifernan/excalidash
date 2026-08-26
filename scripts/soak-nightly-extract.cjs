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

function buildSummary(part, exitCode, resultJson) {
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

  const summary = buildSummary(part, exitCode, resultJson);
  setOutput("board_id", summary.boardId);

  const outDir = path.join(process.env.GITHUB_WORKSPACE || ".", "e2e", "soak-artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "part-summary.json"), JSON.stringify(summary, null, 2));

  console.log(
    `soak-nightly-extract: part ${part} -- passed=${summary.passed} cycles=${summary.cycles} ` +
      `watchdogViolations=${summary.watchdogViolations} boardId=${summary.boardId || "(none found)"}`,
  );
}

if (require.main === module) main();

module.exports = { parseResultLine, buildSummary };
