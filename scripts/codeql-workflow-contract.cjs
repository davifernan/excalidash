#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function inspectCodeqlContract({ workflow, repositoryRules, operations }) {
  const errors = [];
  const triggerBlock = /^on:\s*\n([\s\S]*?)^permissions:/m.exec(workflow)?.[1] ?? "";
  const triggerNames = [...triggerBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);

  if (
    JSON.stringify(triggerNames.sort()) !==
    JSON.stringify(["pull_request", "schedule", "workflow_dispatch"])
  ) {
    errors.push("CodeQL triggers must be exactly pull_request, schedule, and workflow_dispatch");
  }
  if (!/- cron: ["']\d+ \d+ \* \* \*["']/.test(triggerBlock)) {
    errors.push("CodeQL schedule must run daily");
  }
  if (!/^ {4}branches:\s*\n {6}- main$/m.test(triggerBlock)) {
    errors.push("CodeQL pull-request analysis must target main only");
  }
  if (
    !/^ {4}if: github\.event_name == ['"]pull_request['"] \|\| github\.ref == ['"]refs\/heads\/main['"]$/m.test(
      workflow,
    )
  ) {
    errors.push("CodeQL job must accept only pull requests or main itself");
  }
  if (!/^ {2}security-events: write$/m.test(workflow)) {
    errors.push("CodeQL needs security-events: write to publish alerts");
  }
  if (!/github\/codeql-action\/init@v3/.test(workflow)) {
    errors.push("CodeQL initialization action is missing");
  }
  if (!/github\/codeql-action\/analyze@v3/.test(workflow)) {
    errors.push("CodeQL analysis action is missing");
  }
  if (!/^ {10}languages: javascript-typescript$/m.test(workflow)) {
    errors.push("CodeQL must analyze JavaScript and TypeScript");
  }
  if (/\b(queries|query-filters|packs|config-file):/.test(workflow)) {
    errors.push("CodeQL must use the unfiltered default suite");
  }

  const requiredContexts = [...repositoryRules.matchAll(/"context":\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (requiredContexts.some((context) => /codeql/i.test(context))) {
    errors.push("CodeQL must not be a required status check");
  }

  if (!/PR Overseer/.test(operations) || !/every day|same day|daily/i.test(operations)) {
    errors.push("operations must assign same-day daily triage to the PR Overseer");
  }
  if (!/does not prevent|not a merge gate/i.test(operations)) {
    errors.push("operations must say CodeQL detects before merge without becoming a gate");
  }
  if (!/never\s+exclude an entire query/i.test(operations)) {
    errors.push("operations must forbid blanket query exclusions");
  }

  return errors;
}

function inspectRepository() {
  return inspectCodeqlContract({
    workflow: fs.readFileSync(path.join(ROOT, ".github/workflows/codeql.yml"), "utf8"),
    repositoryRules: fs.readFileSync(path.join(ROOT, "ops/repository-rules.sh"), "utf8"),
    operations: fs.readFileSync(path.join(ROOT, "docs/architecture/CODEQL_OPERATIONS.md"), "utf8"),
  });
}

if (require.main === module) {
  const errors = inspectRepository();
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exit(1);
  }
  console.log("CodeQL observer contract holds.");
}

module.exports = { inspectCodeqlContract, inspectRepository };
