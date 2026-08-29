#!/usr/bin/env node
// NIL-639 Hans finding #3: a ~2h soak part had exactly one `free -m` call,
// before the soak started, landing only in the job log -- never in an
// artifact, never repeated. NIL-639 asks explicitly for raw RSS/swap/CPU-time
// values as an artifact so a run that trends toward the swap ceiling (the
// earlier 10-context attempt drove swap to 8191/8191 MB) leaves evidence,
// not just a pass/fail. This runs as a long-lived background process for
// the life of one part (started before the backend/frontend come up,
// stopped right before the final artifact upload in _soak-part.yml),
// appending one JSON line per sample so a crash mid-part still leaves every
// prior sample on disk -- unlike a single summary written once at the end.

const fs = require("fs");
const { execFileSync } = require("child_process");

function parseFreeOutput(text) {
  const lines = text.split("\n");
  const memLine = lines.find((l) => l.startsWith("Mem:"));
  const swapLine = lines.find((l) => l.startsWith("Swap:"));
  const nums = (line) => line.trim().split(/\s+/).slice(1).map(Number);
  const [memTotal, memUsed, memFree, memShared, memBuffCache, memAvailable] = memLine
    ? nums(memLine)
    : [];
  const [swapTotal, swapUsed, swapFree] = swapLine ? nums(swapLine) : [];
  return {
    memTotalMB: memTotal ?? null,
    memUsedMB: memUsed ?? null,
    memFreeMB: memFree ?? null,
    memSharedMB: memShared ?? null,
    memBuffCacheMB: memBuffCache ?? null,
    memAvailableMB: memAvailable ?? null,
    swapTotalMB: swapTotal ?? null,
    swapUsedMB: swapUsed ?? null,
    swapFreeMB: swapFree ?? null,
  };
}

// /proc/stat's first line: "cpu  user nice system idle iowait irq softirq steal ...".
// Raw cumulative jiffy counters since boot -- the point of recording them
// per-sample is that the aggregator can later diff any two samples to get
// CPU time consumed in that window, without this sampler needing to know
// USER_HZ or compute a rate itself.
function parseProcStatCpuLine(text) {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const [, user, nice, system, idle, iowait, irq, softirq, steal] = line.trim().split(/\s+/);
  const n = (v) => (v === undefined ? null : Number(v));
  return {
    userJiffies: n(user),
    niceJiffies: n(nice),
    systemJiffies: n(system),
    idleJiffies: n(idle),
    iowaitJiffies: n(iowait) ?? 0,
    irqJiffies: n(irq) ?? 0,
    softirqJiffies: n(softirq) ?? 0,
    stealJiffies: n(steal) ?? 0,
  };
}

function sampleOnce({
  readFree = () => execFileSync("free", ["-m"], { encoding: "utf8" }),
  readProcStat = () => fs.readFileSync("/proc/stat", "utf8"),
  now = () => new Date().toISOString(),
} = {}) {
  return {
    ts: now(),
    ...parseFreeOutput(readFree()),
    cpu: parseProcStatCpuLine(readProcStat()),
  };
}

function main() {
  function arg(name, fallback) {
    const prefix = `--${name}=`;
    const found = process.argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  }
  const outPath = arg("out", null);
  // 60s: frequent enough that a swap ramp toward the 8191 MB ceiling shows
  // several samples of climb before a ~115min part ends, infrequent enough
  // that ~115 one-line samples add negligible artifact size over the part.
  const intervalMs = Number(arg("interval-ms", "60000"));
  if (!outPath) {
    console.error("soak-resource-sampler: --out=<path> is required");
    process.exit(1);
  }

  function writeSample() {
    try {
      fs.appendFileSync(outPath, JSON.stringify(sampleOnce()) + "\n");
    } catch (err) {
      // A missed sample must not take the sampler down for the rest of the
      // part -- the soak itself is what matters, this is instrumentation.
      console.error(`soak-resource-sampler: sample failed: ${err.message}`);
    }
  }

  writeSample();
  const timer = setInterval(writeSample, intervalMs);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) main();

module.exports = { parseFreeOutput, parseProcStatCpuLine, sampleOnce };
