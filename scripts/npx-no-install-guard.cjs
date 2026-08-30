#!/usr/bin/env node
/**
 * Every `npx` invocation in a GitHub Actions workflow must carry
 * `--no-install`, so a missing or incomplete local install fails loudly
 * instead of npx silently fetching an arbitrary version from the registry
 * and running that instead (NIL-636 soak incident).
 *
 * What happened: NIL-636's root Workspace restructuring hoisted backend's
 * dependencies into the repo-root lockfile and deleted
 * backend/package-lock.json. `_soak-part.yml` still ran `cd backend && npm
 * ci` (no lockfile there anymore) followed by `npx prisma generate`. On a
 * clean GitHub Actions runner npx found no locally installed `prisma`
 * binary resolvable from `backend/`, and rather than failing, silently
 * fetched the newest version from the npm registry -- a `-rc` prerelease
 * with a different CLI surface than the pinned `^5.22.0` -- and the job
 * failed later with a confusing `CLI.UNKNOWN_COMMAND` instead of a clear
 * "backend has no prisma installed" error at the actual point of failure.
 * This runs nightly, not on every PR, so nothing in the required check
 * list caught it.
 *
 * `npx --no-install <pkg>` refuses to install anything: if `<pkg>` is not
 * already resolvable from the current directory upward (exactly the
 * resolution a correct `npm ci` sets up), it exits non-zero immediately
 * naming the missing package, rather than reaching for the network. This
 * check is deliberately narrow -- it only verifies the flag is present on
 * every `npx` call in every workflow file, not that any given install step
 * is otherwise correct. It does not (and cannot) tell you WHERE to put
 * `npm ci` for a given `npx` call to succeed; it only ensures a broken one
 * fails fast and legibly instead of improvising.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("shell-quote");

/**
 * Find every `npx` invocation in a shell command string that is missing
 * `--no-install`, returning the offending snippet (trimmed to a readable
 * length) for each.
 *
 * Shell syntax is tokenized by shell-quote rather than approximated with a
 * regex. That makes command operators (including background `&`), quoted
 * text, comments, command substitutions, and backslash continuations syntax
 * rather than a local list of delimiters this guard has to keep in sync.
 *
 * Deliberately not "the flag must be the very next token": `npx --yes
 * --no-install foo` and `npx --no-install --yes foo` are both fine. The
 * scan considers every unquoted `npx` token and its following words up to
 * the next parser operator.
 */
function findMissingNoInstall(command) {
  // GitHub expands these expressions before the shell sees the command.
  // Replace their non-shell template syntax with one inert shell word before
  // tokenizing, so the surrounding real shell commands remain inspectable.
  const shellSource = command.replace(/\$\{\{[\s\S]*?\}\}/g, "GITHUB_ACTIONS_EXPRESSION");
  const tokens = parse(shellSource);
  const offenders = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "npx") continue;
    const argumentsForCall = [];
    for (let next = index + 1; next < tokens.length && typeof tokens[next] === "string"; next++) {
      argumentsForCall.push(tokens[next]);
    }
    if (!argumentsForCall.includes("--no-install")) {
      const snippet = ["npx", ...argumentsForCall].join(" ").slice(0, 80);
      offenders.push(snippet);
    }
  }
  return offenders;
}

/**
 * Extract every `run:` block's literal string value from a workflow YAML
 * file, without a real YAML parser: a `run:` step's shell script is not
 * YAML structure this check needs to understand, only text to scan, and a
 * hand-rolled scanner avoids adding a YAML dependency to a two-function
 * check. Handles both `run: <one-liner>` and `run: |`/`run: >` block
 * scalars, indentation-delimited the way YAML actually requires.
 */
function extractRunBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(/^(\s*)(?:-\s*)?run:\s+(?!\||>)(.+)$/);
    if (inline) {
      blocks.push({ line: i + 1, text: inline[2] });
      continue;
    }
    const block = line.match(/^(\s*)(?:-\s*)?run:\s*[|>][+-]?\s*$/);
    if (block) {
      const baseIndent = block[1].length;
      const bodyLines = [];
      let j = i + 1;
      let bodyIndent = null;
      for (; j < lines.length; j++) {
        const bodyLine = lines[j];
        if (bodyLine.trim() === "") {
          bodyLines.push("");
          continue;
        }
        const indentMatch = bodyLine.match(/^(\s*)/);
        const indent = indentMatch[1].length;
        if (indent <= baseIndent) break;
        if (bodyIndent === null) bodyIndent = indent;
        bodyLines.push(bodyLine);
      }
      blocks.push({ line: i + 1, text: bodyLines.join("\n") });
      i = j - 1;
    }
  }
  return blocks;
}

function checkFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const findings = [];
  for (const block of extractRunBlocks(text)) {
    for (const offender of findMissingNoInstall(block.text)) {
      findings.push({ file: filePath, line: block.line, snippet: offender });
    }
  }
  return findings;
}

function collectWorkflowFiles(repoRoot) {
  const dir = path.join(repoRoot, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(dir, name));
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args.map((a) => path.resolve(a)) : collectWorkflowFiles(repoRoot);

  let anyFindings = false;
  for (const target of targets) {
    for (const finding of checkFile(target)) {
      anyFindings = true;
      const rel = path.relative(repoRoot, finding.file);
      console.error(
        `NPX WITHOUT --no-install  ${rel}:${finding.line}: \`${finding.snippet}\``,
      );
    }
  }

  if (anyFindings) {
    console.error(
      "\nEvery `npx` call in a workflow must carry --no-install, so a missing local " +
        "install fails loudly instead of silently fetching an arbitrary version " +
        "(NIL-636 soak incident).",
    );
    process.exit(1);
  }
  console.log(`Every npx call in ${targets.length} workflow file(s) carries --no-install.`);
  process.exit(0);
}

module.exports = { findMissingNoInstall, extractRunBlocks, checkFile };

if (require.main === module) main();
