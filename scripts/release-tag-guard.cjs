#!/usr/bin/env node
/**
 * Guards the one fact a release depends on: that our own `VERSION` file names
 * a version whose bare git tag, if it exists at all in this repository, is
 * genuinely an earlier point in *our* history -- not a same-named tag from
 * somewhere else.
 *
 * Measured 24.08.2026 (NIL-507): `VERSION` said `0.6.0`, and a tag `v0.6.0`
 * already existed in this working tree -- but it was ExcaliDash upstream's
 * tag (`ZimengXiong/ExcaliDash`, remote `origin`), pointing at a commit that
 * is not an ancestor of our `main` at all. Our own 0.6.0 release point
 * (`f9108aa`, PR #68) had never been tagged. Anyone who ran `git describe`
 * in a checkout with both remotes configured -- exactly this working tree --
 * got upstream's answer for our commit.
 *
 * The fix is not "never collide" (we do not control upstream's numbering)
 * but "never let a collision go unnoticed": our own release tags always
 * carry the `-nilo.N` suffix (docs/architecture/UPSTREAM_MAINTENANCE.md,
 * "Tag-Namensraum"), so a *bare* `vX.Y.Z` tag existing in this repository is
 * either legitimately ours from before that rule (must be our ancestor) or a
 * foreign one that must never be reused. This check cannot see upstream's
 * tags in CI (the runner only ever clones this repository, not `origin`),
 * so it enforces the narrower, checkable half of that fact: whatever bare
 * tag matching the current VERSION exists *in this repository's own remote*
 * must be an ancestor of the commit being checked. A tag that fails that
 * either points at a foreign commit that slipped in (this is what caught
 * v0.6.0) or was force-moved -- both are exactly what this exists to catch.
 *
 * What this check does NOT do: verify that a git *tag* actually gets created
 * for a given VERSION bump (that happens once, deliberately, after merge --
 * see docs/architecture/RELEASE_PROCESS.md), or that release notes exist for
 * a version (the release workflow generates and drafts those at tag time,
 * see .github/workflows/release.yml, and refuses to publish if VERSION at
 * the tagged commit does not equal the tag's own version number). Those are
 * checked where the fact is actually knowable -- a PR does not yet know its
 * eventual tag, so asserting tag/notes coherence here would either be a
 * no-op or, worse, decorative.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(root, "VERSION");
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function readVersion(versionFile = VERSION_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(versionFile, "utf8");
  } catch (error) {
    return { ok: false, findings: [`cannot read ${versionFile}: ${error.message}`] };
  }
  const version = raw.trim();
  if (!SEMVER_PATTERN.test(version)) {
    return {
      ok: false,
      findings: [`VERSION is \`${JSON.stringify(raw)}\` -- must be exactly \`X.Y.Z\` (no leading "v", no whitespace, no pre-release suffix).`],
    };
  }
  return { ok: true, version };
}

/**
 * Pure decision, kept separate from the git plumbing below so the
 * counterprobe can drive it directly without a real repository for the
 * "invalid VERSION" cases and can otherwise exercise it end-to-end through a
 * disposable sandbox repo for the tag-collision cases.
 */
function evaluateBareTagSafety({ version, tagExists, isAncestor }) {
  const tag = `v${version}`;
  if (!tagExists) {
    return { ok: true, findings: [] };
  }
  if (isAncestor) {
    return { ok: true, findings: [] };
  }
  return {
    ok: false,
    findings: [
      `bare tag \`${tag}\` exists in this repository but is NOT an ancestor of the checked commit -- ` +
        `it names a different piece of history than VERSION currently claims. Our own release tags carry ` +
        `the \`-nilo.N\` suffix (see docs/architecture/UPSTREAM_MAINTENANCE.md, "Tag-Namensraum"); a bare ` +
        `\`${tag}\` that isn't our own ancestor is either a foreign tag that must never be reused, or a ` +
        `force-moved tag, which is worse. Bump VERSION to a number nothing already claims, or tag this ` +
        `point as \`${tag}-nilo.1\` instead of reusing the bare name.`,
    ],
  };
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    return null;
  }
}

function tagExistsAt(tag, cwd) {
  return git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], cwd) !== null;
}

function tagIsAncestorOf(tag, commit, cwd) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", tag, commit], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkRepo({ cwd = root, commit = "HEAD", versionFile = VERSION_FILE } = {}) {
  const versionResult = readVersion(versionFile);
  if (!versionResult.ok) return versionResult;

  const tag = `v${versionResult.version}`;
  const tagExists = tagExistsAt(tag, cwd);
  const isAncestor = tagExists ? tagIsAncestorOf(tag, commit, cwd) : false;
  const tagResult = evaluateBareTagSafety({ version: versionResult.version, tagExists, isAncestor });

  if (!tagResult.ok) return tagResult;
  return {
    ok: true,
    findings: [],
    message: `Release tag guard holds. VERSION=${versionResult.version}; ` +
      (tagExists
        ? `bare tag \`${tag}\` exists and is an ancestor of ${commit}.`
        : `no bare tag \`${tag}\` exists yet in this repository.`),
  };
}

function main() {
  const result = checkRepo();
  if (result.ok) {
    console.log(result.message);
    process.exit(0);
  }
  for (const finding of result.findings) console.error(`VIOLATION  ${finding}`);
  process.exit(1);
}

module.exports = { readVersion, evaluateBareTagSafety, checkRepo, SEMVER_PATTERN, VERSION_FILE };

if (require.main === module) {
  main();
}
