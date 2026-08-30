#!/usr/bin/env node
/**
 * Finds every declared Docker build (compose `build:` blocks, GitHub Actions
 * `docker/build-push-action` steps, and a plain `docker build -f ...` shell
 * invocation) and checks its `context` against what its own Dockerfile's
 * `COPY` instructions actually require (NIL-636).
 *
 * The incident this exists for: NIL-636 moved to a root npm Workspace, so
 * `backend/Dockerfile` now starts with
 *   COPY package.json package-lock.json ./
 *   COPY backend/package.json ./backend/package.json
 *   COPY frontend/package.json ./frontend/package.json
 *   COPY packages/domain/package.json ./packages/domain/package.json
 * which only resolves under the repo root as build context. Six build call
 * sites (`docker-compose.yml`, `docker-compose.lab.yml`,
 * `docker-compose.local-multi.yml` x3, `docker-compose.pg-test.yml`,
 * `release.yml`, `publish-images.yml`) still passed `context: ./backend` --
 * the pre-Workspace shape. `backend/package-lock.json` no longer exists at
 * all (this PR deleted it in favor of the root lockfile), so under that
 * context the very first `COPY` fails outright; the others would have
 * failed one `COPY` later on `frontend/package.json` /
 * `packages/domain/package.json`, neither of which exists under
 * `backend/`. Every one of CI's own checks builds a different image
 * (`frontend/Dockerfile`, already root-context) or none at all, so this
 * broke only the two release-tag build steps -- the ones that run when
 * tagging a release, the most expensive place to discover it.
 *
 * This is a static, best-effort Dockerfile reader: it understands plain
 * `COPY <src...> <dest>` (every source must exist under the context),
 * ignores `COPY --from=<stage>` (that copies from a previous build stage,
 * not the host context), does not evaluate `ARG`/`ONBUILD`/wildcard globs
 * precisely (a glob source is treated as existing if its literal parent
 * directory exists), and does not understand `.dockerignore` exclusions.
 * It has no opinion on whether a context is the "right" one architecturally
 * -- only on whether the Dockerfile's own COPY instructions can find their
 * files there.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function parseDockerfileCopySources(dockerfilePath) {
  const text = fs.readFileSync(dockerfilePath, "utf8");
  const sources = [];
  const lines = text.split("\n");
  let continued = "";
  for (const rawLine of lines) {
    const line = continued + rawLine.trim();
    continued = "";
    if (line.endsWith("\\")) {
      continued = line.slice(0, -1) + " ";
      continue;
    }
    if (!/^COPY\s/i.test(line)) continue;
    if (/--from=/i.test(line)) continue;
    const withoutFlags = line
      .replace(/^COPY\s+/i, "")
      .split(/\s+/)
      .filter((tok) => !tok.startsWith("--"));
    if (withoutFlags.length < 2) continue;
    const dest = withoutFlags[withoutFlags.length - 1];
    const srcTokens = withoutFlags.slice(0, -1);
    for (const src of srcTokens) sources.push(src);
    void dest;
  }
  return sources;
}

function sourceExistsUnderContext(contextDir, src) {
  if (src.includes("*")) {
    const parent = path.dirname(path.join(contextDir, src));
    return fs.existsSync(parent);
  }
  return fs.existsSync(path.join(contextDir, src));
}

function checkBuild({ label, contextDir, dockerfilePath }) {
  if (!fs.existsSync(dockerfilePath)) {
    return [{ label, problem: `Dockerfile not found at ${dockerfilePath}` }];
  }
  const sources = parseDockerfileCopySources(dockerfilePath);
  const missing = sources.filter((src) => !sourceExistsUnderContext(contextDir, src));
  if (missing.length === 0) return [];
  return [
    {
      label,
      problem: `context "${contextDir}" cannot satisfy ${dockerfilePath}'s COPY sources: ${missing.join(", ")}`,
    },
  ];
}

function findComposeBuildBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*build:\s*$/.test(lines[i])) continue;
    let context = null;
    let dockerfile = "Dockerfile";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const cm = l.match(/^\s*context:\s*(\S+)/);
      const dm = l.match(/^\s*dockerfile:\s*(\S+)/);
      if (cm) context = cm[1].replace(/^["']|["']$/g, "");
      if (dm) dockerfile = dm[1].replace(/^["']|["']$/g, "");
      if (cm || dm) continue;
      if (/^\s*[A-Za-z_-]+:/.test(l) && !/^\s{2,}/.test(l)) break;
      if (context !== null && /^\s{0,2}\S/.test(l) && !cm && !dm) break;
    }
    if (context !== null) blocks.push({ line: i + 1, context, dockerfile });
  }
  return blocks;
}

function findWorkflowBuildPushSteps(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*docker\/build-push-action@/.test(lines[i])) continue;
    let context = null;
    let dockerfile = "Dockerfile";
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      const l = lines[j];
      const cm = l.match(/^\s*context:\s*(\S+)/);
      const fm = l.match(/^\s*file:\s*(\S+)/);
      if (cm) context = cm[1].replace(/^["']|["']$/g, "");
      if (fm) dockerfile = fm[1].replace(/^["']|["']$/g, "");
      if (/^\s*- name:/.test(l) && j > i + 1) break;
    }
    if (context !== null) blocks.push({ line: i + 1, context, dockerfile });
  }
  return blocks;
}

function findShellDockerBuilds(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/docker build\s+(.*)/);
    if (!m) continue;
    const args = m[1];
    const fm = args.match(/-f\s+(\S+)/);
    const dockerfile = fm ? fm[1] : "Dockerfile";
    const rest = args.replace(/-f\s+\S+/, "").trim();
    const tokens = rest
      .split(/\s+/)
      .filter((t) => !t.startsWith("-t") && !t.startsWith("excalidash"));
    const context = tokens[tokens.length - 1];
    if (context) blocks.push({ line: i + 1, context, dockerfile });
  }
  return blocks;
}

// A hand-maintained file list is exactly the shape of gap this guard exists
// to close: `local/oidc-sandbox.yml` (two build blocks, still `context:
// ../backend`) was never on the original six-file list because nobody
// thought to add it, and the guard passed clean anyway. Discovering every
// `.yml`/`.yaml` file in the repo -- not a list of the ones someone already
// knew about -- is what "the class, not the eight known spots" has to mean
// in code, not just in the commit message.
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".vite",
  ".vite-temp",
]);

const walkYamlFiles = (dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkYamlFiles(full, out);
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
};

const relFiles = (repoRoot, dir) =>
  walkYamlFiles(path.join(repoRoot, dir))
    .map((abs) => path.relative(repoRoot, abs).split(path.sep).join("/"))
    .sort();

const SHELL_BUILD_FILES = [".github/workflows/test.yml"];

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const problems = [];

  // Workflow YAML is walked and checked separately below (different build
  // syntax entirely -- `with: {context, file}` on a build-push-action step,
  // not a compose `build: {context, dockerfile}` block), so it is excluded
  // here rather than risk two passes disagreeing about the same file.
  const composeFiles = relFiles(repoRoot, ".").filter((rel) => !rel.startsWith(".github/"));

  for (const rel of composeFiles) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const composeDir = path.dirname(abs);
    const text = fs.readFileSync(abs, "utf8");
    for (const block of findComposeBuildBlocks(text)) {
      const contextDir = path.resolve(composeDir, block.context);
      const dockerfilePath = path.join(contextDir, block.dockerfile);
      const found = checkBuild({
        label: `${rel}:${block.line} (context: ${block.context}, dockerfile: ${block.dockerfile})`,
        contextDir,
        dockerfilePath,
      });
      problems.push(...found);
    }
  }

  const workflowFiles = relFiles(repoRoot, ".github/workflows");

  for (const rel of workflowFiles) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    for (const block of findWorkflowBuildPushSteps(text)) {
      const contextDir = path.resolve(repoRoot, block.context);
      const dockerfilePath = path.resolve(repoRoot, block.dockerfile);
      const found = checkBuild({
        label: `${rel}:${block.line} (context: ${block.context}, file: ${block.dockerfile})`,
        contextDir,
        dockerfilePath,
      });
      problems.push(...found);
    }
  }

  for (const rel of SHELL_BUILD_FILES) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    for (const block of findShellDockerBuilds(text)) {
      const contextDir = path.resolve(repoRoot, block.context);
      const dockerfilePath = path.resolve(repoRoot, block.dockerfile);
      const found = checkBuild({
        label: `${rel}:${block.line} (context: ${block.context}, -f ${block.dockerfile})`,
        contextDir,
        dockerfilePath,
      });
      problems.push(...found);
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`DOCKER CONTEXT MISMATCH  ${p.label}\n  ${p.problem}`);
    process.exit(1);
  }
  console.log("All Docker build contexts satisfy their Dockerfile's COPY sources.");
  process.exit(0);
}

module.exports = {
  parseDockerfileCopySources,
  sourceExistsUnderContext,
  checkBuild,
  findComposeBuildBlocks,
  findWorkflowBuildPushSteps,
  findShellDockerBuilds,
  walkYamlFiles,
  relFiles,
};

if (require.main === module) main();
