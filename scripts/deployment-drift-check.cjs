#!/usr/bin/env node
/**
 * Drift check between the running production deployment and the canonical
 * `docker-compose.prod.yml` on `main` (NIL-416).
 *
 * The production instance is not started from a checkout of this repo -- it
 * is started from a hand-maintained compose file on the host
 * (`/home/claude/excalidash/docker-compose.yml`). That file drifted from the
 * repo silently: it lost the `logging` block at some point during manual
 * edits, and unbounded container logs went unnoticed for a long time because
 * the container restarts often and the log disappears with it.
 *
 * This does not try to be a general YAML differ. Most of the differences
 * between the deployment file and `docker-compose.prod.yml` are deliberate
 * host overrides (loopback-only ports behind nginx, an extra host port for
 * the MCP adapter, a hardcoded FRONTEND_URL/TRUST_PROXY, a stricter
 * EXCALIDASH_IMAGE_TAG error message) -- see the NIL-416 ticket comment for
 * the full enumeration. What this checks is narrow, on purpose: the handful
 * of operational settings where a silent gap is a real outage risk rather
 * than a style choice --
 *
 *   - `logging` (driver + max-size + max-file), the exact gap this ticket
 *     found: unbounded logs fill the disk.
 *   - `mem_limit` / `memswap_limit`, because their comment explains they
 *     exist to stop a runaway container from dragging the whole host into
 *     swap -- a value silently reverting to "unset" is the same class of
 *     failure as the missing logging block.
 *
 * Fails closed: an unreadable deployment file, an unreadable canonical file,
 * or a service present in the canonical file but missing from the deployment
 * file is a failure, not a skip. A check that shrugs at "I couldn't tell" is
 * exactly the gap this ticket is about.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

const CHECKED_KEYS = ["mem_limit", "memswap_limit"];

/** Splits a compose file's `services:` block into { name: blockText }. */
function extractServiceBlocks(yamlText) {
  const lines = yamlText.split("\n");
  const servicesStart = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (servicesStart === -1) {
    throw new Error("no top-level `services:` key found");
  }
  const blocks = {};
  let current = null;
  let currentLines = [];
  const flush = () => {
    if (current) blocks[current] = currentLines.join("\n");
  };
  for (let i = servicesStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // dedented back out of `services:`
    const serviceMatch = line.match(/^ {2}(\S+):\s*$/);
    if (serviceMatch) {
      flush();
      current = serviceMatch[1];
      currentLines = [];
    } else if (current) {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

/** Resolves top-level `x-name: &anchor` blocks so `*anchor` references can be inlined. */
function extractAnchors(yamlText) {
  const anchors = {};
  const lines = yamlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const anchorMatch = lines[i].match(/^\S[\w-]*:\s*&(\S+)\s*$/);
    if (!anchorMatch) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
      body.push(lines[j].replace(/^ {2}/, ""));
    }
    anchors[anchorMatch[1]] = body.join("\n");
  }
  return anchors;
}

/** Extracts the resolved `logging:` block (driver/max-size/max-file) for one service. */
function extractLogging(serviceBlockText, anchors) {
  const refMatch = serviceBlockText.match(/^ {4}logging:\s*\*(\S+)\s*$/m);
  let body;
  if (refMatch) {
    body = anchors[refMatch[1]];
    if (body === undefined) {
      throw new Error(`logging: *${refMatch[1]} has no matching anchor definition`);
    }
  } else {
    const inlineMatch = serviceBlockText.match(/^ {4}logging:\s*\n((?: {6}.*\n?)+)/m);
    if (!inlineMatch) return null;
    body = inlineMatch[1];
  }
  const driver = body.match(/driver:\s*(\S+)/)?.[1];
  const maxSize = body.match(/max-size:\s*"?([^"\n]+)"?/)?.[1]?.trim();
  const maxFile = body.match(/max-file:\s*"?([^"\n]+)"?/)?.[1]?.trim();
  if (!driver || !maxSize || !maxFile) return null;
  return { driver, maxSize, maxFile };
}

function extractKeyValues(serviceBlockText) {
  const values = {};
  for (const key of CHECKED_KEYS) {
    const match = serviceBlockText.match(new RegExp(`^ {4}${key}:\\s*(\\S+)\\s*$`, "m"));
    if (match) values[key] = match[1];
  }
  return values;
}

function readCanonicalComposeFromGit(repoPath, ref) {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    throw new Error(`ref "${ref}" must be "<remote>/<branch>" (e.g. "own/main")`);
  }
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);
  const fetch = spawnSync("git", ["-C", repoPath, "fetch", remote, branch], {
    encoding: "utf8",
  });
  if (fetch.status !== 0) {
    throw new Error(`git fetch ${remote} ${branch} failed in ${repoPath}: ${fetch.stderr || fetch.stdout}`);
  }
  const show = spawnSync("git", ["-C", repoPath, "show", `${ref}:docker-compose.prod.yml`], {
    encoding: "utf8",
  });
  if (show.status !== 0) {
    throw new Error(`git show ${ref}:docker-compose.prod.yml failed in ${repoPath}: ${show.stderr || show.stdout}`);
  }
  const sha = spawnSync("git", ["-C", repoPath, "rev-parse", ref], { encoding: "utf8" });
  return { text: show.stdout, sha: sha.stdout.trim() || ref };
}

function checkDrift({ deploymentPath, canonicalText, canonicalLabel }) {
  const findings = [];

  let deploymentText;
  try {
    deploymentText = fs.readFileSync(deploymentPath, "utf8");
  } catch (err) {
    return { ok: false, findings: [`cannot read deployment compose file ${deploymentPath}: ${err.message}`] };
  }

  let canonicalServices;
  let deploymentServices;
  let anchors;
  try {
    anchors = extractAnchors(canonicalText);
    canonicalServices = extractServiceBlocks(canonicalText);
    deploymentServices = extractServiceBlocks(deploymentText);
  } catch (err) {
    return { ok: false, findings: [`cannot parse compose files: ${err.message}`] };
  }

  for (const [name, canonicalBlock] of Object.entries(canonicalServices)) {
    const deploymentBlock = deploymentServices[name];
    if (deploymentBlock === undefined) {
      findings.push(`service "${name}" exists in ${canonicalLabel} but not in ${deploymentPath}`);
      continue;
    }

    let canonicalLogging;
    let deploymentLogging;
    try {
      canonicalLogging = extractLogging(canonicalBlock, anchors);
    } catch (err) {
      findings.push(`service "${name}" in ${canonicalLabel}: ${err.message}`);
      continue;
    }
    if (canonicalLogging) {
      try {
        deploymentLogging = extractLogging(deploymentBlock, {});
      } catch (err) {
        findings.push(`service "${name}" in ${deploymentPath}: ${err.message}`);
        deploymentLogging = null;
      }
      if (!deploymentLogging) {
        findings.push(
          `service "${name}": ${deploymentPath} has no logging block (expected ${JSON.stringify(canonicalLogging)})`,
        );
      } else if (
        deploymentLogging.driver !== canonicalLogging.driver ||
        deploymentLogging.maxSize !== canonicalLogging.maxSize ||
        deploymentLogging.maxFile !== canonicalLogging.maxFile
      ) {
        findings.push(
          `service "${name}": logging mismatch -- deployment has ${JSON.stringify(deploymentLogging)}, ` +
            `${canonicalLabel} has ${JSON.stringify(canonicalLogging)}`,
        );
      }
    }

    const canonicalKV = extractKeyValues(canonicalBlock);
    const deploymentKV = extractKeyValues(deploymentBlock);
    for (const key of CHECKED_KEYS) {
      if (canonicalKV[key] === undefined) continue;
      if (deploymentKV[key] !== canonicalKV[key]) {
        findings.push(
          `service "${name}": ${key} mismatch -- deployment has ${deploymentKV[key] ?? "(unset)"}, ` +
            `${canonicalLabel} has ${canonicalKV[key]}`,
        );
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

function main() {
  const deploymentPath = process.env.DEPLOYMENT_COMPOSE_PATH || "/home/claude/excalidash/docker-compose.yml";
  const repoPath = process.env.DRIFT_CHECK_REPO_PATH || root;
  // "own" is davifernan/excalidash, this fork's remote and the branch this
  // deployment actually ships from -- "origin" is upstream ZimengXiong/ExcaliDash.
  // Matches SENTINEL_MAIN_REF in ops/systemd/excalidash-pipeline-sentinel.service.
  const ref = process.env.DRIFT_CHECK_REF || "own/main";

  let canonical;
  try {
    canonical = readCanonicalComposeFromGit(repoPath, ref);
  } catch (err) {
    console.error(`CANNOT VERIFY  ${err.message}`);
    process.exit(1);
  }

  const result = checkDrift({
    deploymentPath,
    canonicalText: canonical.text,
    canonicalLabel: `docker-compose.prod.yml@${canonical.sha}`,
  });

  if (result.ok) {
    console.log(
      `Deployment compose holds. ${deploymentPath} matches docker-compose.prod.yml@${canonical.sha} on logging and memory limits.`,
    );
    process.exit(0);
  }

  for (const finding of result.findings) console.error(`DRIFT  ${finding}`);
  process.exit(1);
}

module.exports = { extractServiceBlocks, extractAnchors, extractLogging, extractKeyValues, checkDrift };

if (require.main === module) main();
