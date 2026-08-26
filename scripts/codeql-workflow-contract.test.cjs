"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { inspectCodeqlContract, inspectRepository } = require("./codeql-workflow-contract.cjs");

const ROOT = path.join(__dirname, "..");
const REAL = {
  workflow: fs.readFileSync(path.join(ROOT, ".github/workflows/codeql.yml"), "utf8"),
  repositoryRules: fs.readFileSync(path.join(ROOT, "ops/repository-rules.sh"), "utf8"),
  operations: fs.readFileSync(path.join(ROOT, "docs/architecture/CODEQL_OPERATIONS.md"), "utf8"),
};

test("the repository keeps CodeQL on PRs and daily main, unfiltered and non-required", () => {
  assert.deepEqual(inspectRepository(), []);
});

test("the contract rejects a push trigger", () => {
  const workflow = REAL.workflow.replace(
    "  workflow_dispatch:\n",
    "  workflow_dispatch:\n  push:\n",
  );
  assert.match(inspectCodeqlContract({ ...REAL, workflow }).join("\n"), /triggers must be exactly/);
});

test("the contract rejects a query exclusion", () => {
  const workflow = REAL.workflow.replace(
    "          languages: javascript-typescript\n",
    "          languages: javascript-typescript\n          queries: -security-and-quality\n",
  );
  assert.match(inspectCodeqlContract({ ...REAL, workflow }).join("\n"), /unfiltered default suite/);
});

test("the contract rejects CodeQL becoming required", () => {
  const repositoryRules = REAL.repositoryRules.replace(
    '{ "context": "Backend Tests" },',
    '{ "context": "Backend Tests" },\n          { "context": "CodeQL Daily Observer" },',
  );
  assert.match(
    inspectCodeqlContract({ ...REAL, repositoryRules }).join("\n"),
    /must not be a required status check/,
  );
});

test("the contract rejects an ownerless alert inbox", () => {
  const operations = REAL.operations.replaceAll("PR Overseer", "release operator");
  assert.match(
    inspectCodeqlContract({ ...REAL, operations }).join("\n"),
    /assign same-day daily triage/,
  );
});
