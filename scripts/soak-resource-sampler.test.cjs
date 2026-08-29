"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  parseFreeOutput,
  parseProcStatCpuLine,
  sampleOnce,
} = require("./soak-resource-sampler.cjs");

const FREE_OUTPUT = `              total        used        free      shared  buff/cache   available
Mem:           15924        7211        3168        2503        8418        8712
Swap:           8191        5350        2841
`;

const PROC_STAT = `cpu  123456 789 45678 9012345 234 12 34 0 0 0
cpu0 61728 394 22839 4506172 117 6 17 0 0 0
intr 12345 0 0 0
`;

test("parseFreeOutput reads Mem and Swap lines from free -m output", () => {
  assert.deepStrictEqual(parseFreeOutput(FREE_OUTPUT), {
    memTotalMB: 15924,
    memUsedMB: 7211,
    memFreeMB: 3168,
    memSharedMB: 2503,
    memBuffCacheMB: 8418,
    memAvailableMB: 8712,
    swapTotalMB: 8191,
    swapUsedMB: 5350,
    swapFreeMB: 2841,
  });
});

test("parseFreeOutput tolerates missing lines rather than throwing", () => {
  assert.deepStrictEqual(parseFreeOutput("garbage\n"), {
    memTotalMB: null,
    memUsedMB: null,
    memFreeMB: null,
    memSharedMB: null,
    memBuffCacheMB: null,
    memAvailableMB: null,
    swapTotalMB: null,
    swapUsedMB: null,
    swapFreeMB: null,
  });
});

test("parseProcStatCpuLine reads the aggregate cpu line's raw jiffy counters", () => {
  assert.deepStrictEqual(parseProcStatCpuLine(PROC_STAT), {
    userJiffies: 123456,
    niceJiffies: 789,
    systemJiffies: 45678,
    idleJiffies: 9012345,
    iowaitJiffies: 234,
    irqJiffies: 12,
    softirqJiffies: 34,
    stealJiffies: 0,
  });
});

test("parseProcStatCpuLine returns null when the cpu line is absent", () => {
  assert.strictEqual(parseProcStatCpuLine("intr 12345\n"), null);
});

test("sampleOnce combines free and /proc/stat reads with a timestamp, via injected readers", () => {
  const sample = sampleOnce({
    readFree: () => FREE_OUTPUT,
    readProcStat: () => PROC_STAT,
    now: () => "2026-08-28T00:00:00.000Z",
  });
  assert.strictEqual(sample.ts, "2026-08-28T00:00:00.000Z");
  assert.strictEqual(sample.memUsedMB, 7211);
  assert.strictEqual(sample.swapUsedMB, 5350);
  assert.strictEqual(sample.cpu.userJiffies, 123456);
});
