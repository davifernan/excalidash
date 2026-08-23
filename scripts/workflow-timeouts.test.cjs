"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Every workflow job needs an upper bound on the damage it can do.
 *
 * Without `timeout-minutes` GitHub lets a job run for six hours. That is not a
 * theoretical number: an E2E job whose server never comes back looks exactly
 * like one that is still working, and the only thing that ends it is the
 * default. A limit is not an expectation of how long the job takes — it should
 * never be reached. It decides how long a broken run costs before somebody
 * finds out.
 *
 * Parsed by hand rather than with a YAML dependency: the scripts directory has
 * none, and the shape being checked here is a single well-known line.
 */
const WORKFLOW_DIR = path.join(__dirname, "..", ".github", "workflows");

const jobsWithoutTimeout = (source) => {
  const lines = source.split(/\r?\n/);
  const jobsStart = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsStart === -1) return [];

  const missing = [];
  let current = null;
  let hasTimeout = false;

  const close = () => {
    if (current && !hasTimeout) missing.push(current);
  };

  for (const line of lines.slice(jobsStart + 1)) {
    const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobHeader) {
      close();
      current = jobHeader[1];
      hasTimeout = false;
      continue;
    }
    if (/^\S/.test(line) && line.trim() !== "") {
      close();
      current = null;
      continue;
    }
    if (current && /^ {4}timeout-minutes:\s*\d+\s*$/.test(line)) hasTimeout = true;
  }
  close();

  return missing;
};

test("every workflow job has a timeout", () => {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

  assert.ok(files.length > 0, "no workflow files found");

  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    for (const job of jobsWithoutTimeout(source)) offenders.push(`${file}: ${job}`);
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `jobs without timeout-minutes:\n  ${offenders.join("\n  ")}`,
  );
});

test("the check notices a job that has no timeout", () => {
  const source = [
    "jobs:",
    "  bounded:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    steps:",
    "      - run: true",
    "  unbounded:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: true",
  ].join("\n");

  assert.deepStrictEqual(jobsWithoutTimeout(source), ["unbounded"]);
});

test("a commented-out timeout does not count", () => {
  const source = ["jobs:", "  pretend:", "    runs-on: ubuntu-latest", "    # timeout-minutes: 10"].join(
    "\n",
  );

  assert.deepStrictEqual(jobsWithoutTimeout(source), ["pretend"]);
});
