"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/**
 * NIL-639 Hans finding on #223 (High): part_3 declares `needs: part_2` and
 * part_4 declares `needs: part_3` -- but both read `board_id:` from
 * `needs.part_1.outputs.board_id`. GitHub Actions only populates the
 * `needs` context for a job's DIRECT dependencies, never transitively --
 * part_1 is not in part_3's or part_4's own `needs:` list, so
 * `needs.part_1` is empty there and both parts fall back to `""` (the
 * `default: ""` on _soak-part.yml's own `board_id` input), which makes
 * team-readiness.spec.ts create a FRESH board instead of reusing the shared
 * one. That silently breaks the entire point of chaining the four parts:
 * NIL-639 measures sustained accumulation across one continuous board, not
 * four unrelated boards.
 *
 * This does not assert "the SHA looks right" -- it parses each part_N job's
 * real `needs:` and `board_id:` lines out of the actual workflow file and
 * asserts the job named in `board_id: ${{ needs.<job>.outputs.board_id }}`
 * is a job actually listed in that same job's own `needs:`. Reverting
 * either part_3's or part_4's board_id line back to `needs.part_1...` turns
 * this test red without touching this file.
 */

const WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "nightly-team-readiness-soak.yml",
);

// Returns { part_1: { needs: [...] | null, boardIdFrom: string | null }, ... }
// by hand-parsing the `jobs:` block -- no YAML dependency in scripts/, same
// approach as workflow-timeouts.test.cjs.
function parsePartJobs(workflowSource) {
  const lines = workflowSource.split(/\r?\n/);
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notStrictEqual(jobsStart, -1, "no top-level jobs: block found");

  const jobs = {};
  let current = null;

  for (const line of lines.slice(jobsStart + 1)) {
    const jobHeader = /^ {2}(part_\d+|summary):\s*$/.exec(line);
    if (jobHeader) {
      current = jobHeader[1];
      jobs[current] = { needs: [], boardIdFrom: null };
      continue;
    }
    if (/^ {2}\S/.test(line) && !jobHeader) {
      current = null; // left the part_N/summary job block
      continue;
    }
    if (!current || !jobs[current]) continue;

    const needsSingle = /^ {4}needs:\s*(\S+)\s*$/.exec(line);
    if (needsSingle) {
      jobs[current].needs.push(needsSingle[1]);
      continue;
    }
    const needsListItem = /^ {6}- (\S+)\s*$/.exec(line);
    if (needsListItem && lines[lines.indexOf(line) - 1]?.trim() === "needs:") {
      jobs[current].needs.push(needsListItem[1]);
      continue;
    }

    const boardIdRef = /board_id:\s*\$\{\{\s*needs\.(\S+)\.outputs\.board_id\s*\}\}/.exec(line);
    if (boardIdRef) jobs[current].boardIdFrom = boardIdRef[1];
  }

  return jobs;
}

test("every part_N>1's board_id input references a job listed in that same job's own needs:", () => {
  const workflowSource = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const jobs = parsePartJobs(workflowSource);

  const partsWithBoardIdInput = Object.keys(jobs).filter(
    (name) => /^part_[234]$/.test(name) && jobs[name].boardIdFrom,
  );
  assert.ok(
    partsWithBoardIdInput.length >= 3,
    `expected part_2, part_3 and part_4 to all set a board_id: input, found: ${partsWithBoardIdInput.join(", ")}`,
  );

  for (const name of partsWithBoardIdInput) {
    const { needs, boardIdFrom } = jobs[name];
    assert.ok(
      needs.includes(boardIdFrom),
      `${name} reads board_id from needs.${boardIdFrom}.outputs.board_id, but its own needs: is ` +
        `[${needs.join(", ")}] -- GitHub only fills the needs context for DIRECT dependencies, so ` +
        `needs.${boardIdFrom} would be empty here and this part would create a fresh board instead ` +
        `of reusing the shared one.`,
    );
  }
});

test("aggregate fails rather than reporting success when any required part failed, was cancelled, or was skipped", () => {
  const workflowSource = fs.readFileSync(WORKFLOW_PATH, "utf8");
  assert.ok(
    /name: Fail the aggregate when a required soak part did not pass[\s\S]*?run: node scripts\/soak-required-part-result\.cjs --enforce/.test(
      workflowSource,
    ),
    "Aggregate + report must execute the required-part enforcement helper",
  );
  assert.ok(
    /status="\$\(NEEDS_JSON='\$\{\{ toJSON\(needs\) \}\}' node scripts\/soak-required-part-result\.cjs\)"[\s\S]*?--status="\$status"/.test(
      workflowSource,
    ),
    "the tracking-issue notification must use the required-part helper status",
  );
  assert.ok(
    !/name: Fail the aggregate when a required soak part did not pass[\s\S]*?continue-on-error:\s*true/.test(
      workflowSource,
    ),
    "the required-part enforcement step must not be neutralized with continue-on-error",
  );
});
