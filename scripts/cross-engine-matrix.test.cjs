#!/usr/bin/env node
/**
 * The cross-engine matrix must keep covering every engine it used to (NIL-652).
 *
 * Before the split, one job ran `--project=firefox --project=webkit
 * --project=mobile-chrome` in a single command. Dropping an engine from that
 * line would have been visible in review as a deleted flag. After the split it
 * is one line in a YAML matrix, and a deleted entry looks like tidying: CI
 * stays green, one engine simply stops being tested, and nothing says so.
 *
 * That is the same failure shape as the artifact-path bug found on the nightly
 * soak the day before -- a guard that silently reports success while measuring
 * nothing. So this asserts the set explicitly rather than trusting review.
 *
 * It checks three things:
 *   1. the matrix covers exactly the engines cross-engine is responsible for;
 *   2. every one of them is a real project in playwright.config.ts, so a
 *      renamed project cannot leave the matrix pointing at nothing;
 *   3. every entry names the browser `playwright install` needs, since
 *      mobile-chrome installs `chromium` and a copied-down entry that installs
 *      the wrong browser fails only at runtime.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github/workflows/test.yml");
const PW_CONFIG = path.join(ROOT, "e2e/playwright.config.ts");

/** The engines cross-engine exists to cover. Changing this set is a product
 *  decision, so it lives here in the open rather than being derived. */
const REQUIRED = {
  firefox: "firefox",
  webkit: "webkit",
  "mobile-chrome": "chromium",
};

/** Browsers `npx playwright install` accepts for our engines. */
const INSTALLABLE = new Set(["firefox", "webkit", "chromium"]);

function readCrossEngineMatrix() {
  const yaml = fs.readFileSync(WORKFLOW, "utf8");
  const jobStart = yaml.indexOf("\n  e2e-cross-engine:");
  assert.notStrictEqual(jobStart, -1, "e2e-cross-engine job not found in test.yml");

  // Up to the next top-level job key (two-space indent, not part of this job).
  const rest = yaml.slice(jobStart + 1);
  const nextJob = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const job = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);

  const entries = [];
  const re = /-\s+project:\s*([A-Za-z0-9-]+)\s*\n\s+browser:\s*([A-Za-z0-9-]+)/g;
  let m;
  while ((m = re.exec(job)) !== null) entries.push({ project: m[1], browser: m[2] });
  return { job, entries };
}

test("cross-engine matrix covers exactly the required engines", () => {
  const { entries } = readCrossEngineMatrix();
  const projects = entries.map((e) => e.project).sort();
  assert.deepStrictEqual(
    projects,
    Object.keys(REQUIRED).sort(),
    `cross-engine matrix must cover exactly ${Object.keys(REQUIRED).join(", ")}; found ${projects.join(", ") || "(none)"}`,
  );
});

test("each matrix entry installs the browser that project needs", () => {
  const { entries } = readCrossEngineMatrix();
  for (const { project, browser } of entries) {
    assert.strictEqual(
      browser,
      REQUIRED[project],
      `project ${project} must install ${REQUIRED[project]}, not ${browser}`,
    );
    assert.ok(INSTALLABLE.has(browser), `${browser} is not an installable Playwright browser`);
  }
});

test("every matrix project exists in playwright.config.ts", () => {
  const config = fs.readFileSync(PW_CONFIG, "utf8");
  const declared = new Set(
    [...config.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  for (const project of Object.keys(REQUIRED)) {
    assert.ok(
      declared.has(project),
      `matrix references project "${project}", which playwright.config.ts does not declare`,
    );
  }
});

test("the job runs one project per entry, not the old combined invocation", () => {
  const { job } = readCrossEngineMatrix();
  assert.ok(
    job.includes("--project=${{ matrix.project }}"),
    "cross-engine must run the matrix project, so each engine gets its own timeout budget",
  );
  assert.ok(
    !/--project=\w[\w-]*\s+--project=/.test(job),
    "cross-engine must not run several projects in one invocation again (NIL-652)",
  );
});
