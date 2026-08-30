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
 * are plain semver; this check is what keeps them safe (docs/architecture/UPSTREAM_MAINTENANCE.md,
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
const CHANGELOG_FILE = path.join(root, "CHANGELOG.md");
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const RELEASE_SOURCE_PATTERN = /^\s*<!--\s*release-source:\s*((?:#\d+)(?:\s*,\s*#\d+)*)\s*-->\s*$/;

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
      `tag \`${tag}\` exists in this repository but is NOT an ancestor of the checked commit -- ` +
        `it names a different piece of history than VERSION currently claims. That is either a foreign ` +
        `tag -- upstream's \`vX.Y.Z\` namespace overlaps ours -- which must never be reused, or a ` +
        `force-moved tag, which is worse. Bump VERSION to a number nothing already claims. ` +
        `See docs/architecture/UPSTREAM_MAINTENANCE.md, "Tag-Namensraum": this check is what makes ` +
        `plain semver tags safe here, so do not work around it by inventing a suffix.`,
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

function parseReleaseClaims(changelog, version) {
  const header = new RegExp(`^## v${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)[^\\n]*$`, "m");
  const match = header.exec(changelog);
  if (!match) {
    return { ok: false, findings: [`CHANGELOG.md has no section for VERSION=${version}.`] };
  }

  const sectionStart = match.index + match[0].length;
  const nextSection = /\n## v\d+\.\d+\.\d+(?:\s|$)/g;
  nextSection.lastIndex = sectionStart;
  const nextMatch = nextSection.exec(changelog);
  const section = changelog.slice(sectionStart, nextMatch ? nextMatch.index : undefined);
  const claims = [];
  const findings = [];
  let pendingSources = null;
  let currentClaim = null;

  // Every line in a version section has one deliberate treatment:
  // - blank line / ### heading: finish a claim and reject an unconsumed marker;
  // - release-source marker: starts exactly one pending source;
  // - list item: starts a claim and consumes that source if present;
  // - every other non-empty line: starts or continues a prose claim.
  // There is no silent "other" path. A source marker is a one-claim token,
  // never state that may cross a section boundary into an unrelated claim.
  const finishClaim = () => {
    if (currentClaim) claims.push(currentClaim);
    currentClaim = null;
  };
  const rejectPendingSource = (reason) => {
    if (!pendingSources) return;
    findings.push(
      `CHANGELOG.md v${version} release-source marker at section line ${pendingSources.line} ${reason}.`,
    );
    pendingSources = null;
  };
  const consumePendingSource = () => {
    const sources = pendingSources?.sources || [];
    pendingSources = null;
    return sources;
  };

  for (const [offset, line] of section.split("\n").entries()) {
    const sourceMatch = line.match(RELEASE_SOURCE_PATTERN);
    if (sourceMatch) {
      finishClaim();
      rejectPendingSource("is followed by another release-source marker instead of a claim");
      pendingSources = { line: offset + 1, sources: sourceMatch[1].match(/\d+/g).map(Number) };
      continue;
    }
    if (line.trim() === "" || /^###\s/.test(line)) {
      finishClaim();
      rejectPendingSource(line.trim() === "" ? "is followed by a blank line instead of a claim" : "is followed by a section heading instead of a claim");
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      finishClaim();
      currentClaim = { line: offset + 1, text: line.trim(), sources: consumePendingSource() };
      continue;
    }
    if (currentClaim) currentClaim.text += ` ${line.trim()}`;
    else {
      currentClaim = { line: offset + 1, text: line.trim(), sources: consumePendingSource() };
    }
  }

  finishClaim();
  rejectPendingSource("ends the version section without a claim");
  return { ok: findings.length === 0, findings, claims };
}

function hasUsableUserFacing(body) {
  const values = [...String(body || "").matchAll(/^User-Facing:\s*(.*)$/gm)].map((match) => match[1].trim());
  return values.length === 1 && values[0] !== "" && values[0] !== "none";
}

function evaluateChangelogDelivery({ version, changelog, getDelivery, isAncestor }) {
  const parsed = parseReleaseClaims(changelog, version);
  if (!parsed.claims) return parsed;

  const findings = [...parsed.findings];
  for (const claim of parsed.claims) {
    if (claim.sources.length === 0) {
      findings.push(`CHANGELOG.md v${version} claim at section line ${claim.line} has no release-source marker: ${claim.text}`);
      continue;
    }
    for (const prNumber of claim.sources) {
      let delivery;
      try {
        delivery = getDelivery(prNumber);
      } catch (error) {
        findings.push(`CHANGELOG.md v${version} claim at section line ${claim.line} cannot read source PR #${prNumber}: ${error.message}`);
        continue;
      }
      if (delivery.state !== "MERGED" || !delivery.mergeCommit) {
        findings.push(`CHANGELOG.md v${version} claim at section line ${claim.line} cites PR #${prNumber}, which is not merged.`);
        continue;
      }
      if (!isAncestor(delivery.mergeCommit)) {
        findings.push(`CHANGELOG.md v${version} claim at section line ${claim.line} cites PR #${prNumber}, whose merge commit is not an ancestor of the checked commit.`);
        continue;
      }
      if (!hasUsableUserFacing(delivery.body)) {
        findings.push(`CHANGELOG.md v${version} claim at section line ${claim.line} cites PR #${prNumber}, which has no usable User-Facing delivery contract.`);
      }
    }
  }
  return findings.length > 0 ? { ok: false, findings } : { ok: true, findings: [] };
}

function getLiveDelivery(prNumber, cwd) {
  const raw = execFileSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "state,mergeCommit,body"],
    { cwd, encoding: "utf8" },
  );
  const pr = JSON.parse(raw);
  return { state: pr.state, mergeCommit: pr.mergeCommit?.oid || null, body: pr.body || "" };
}

function checkRepo(options = {}) {
  const cwd = options.cwd || root;
  const commit = options.commit || "HEAD";
  const versionFile = options.versionFile || path.join(cwd, "VERSION");
  const changelogFile = options.changelogFile || path.join(cwd, "CHANGELOG.md");
  const versionResult = readVersion(versionFile);
  if (!versionResult.ok) return versionResult;

  const tag = `v${versionResult.version}`;
  const tagExists = tagExistsAt(tag, cwd);
  const isAncestor = tagExists ? tagIsAncestorOf(tag, commit, cwd) : false;
  const tagResult = evaluateBareTagSafety({ version: versionResult.version, tagExists, isAncestor });

  if (!tagResult.ok) return tagResult;

  if (fs.existsSync(changelogFile)) {
    const changelog = fs.readFileSync(changelogFile, "utf8");
    const changelogResult = evaluateChangelogDelivery({
      version: versionResult.version,
      changelog,
      getDelivery: options.getDelivery || ((prNumber) => getLiveDelivery(prNumber, cwd)),
      isAncestor: options.isAncestor || ((mergeCommit) => tagIsAncestorOf(mergeCommit, commit, cwd)),
    });
    if (!changelogResult.ok) return changelogResult;
  }
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

module.exports = {
  readVersion,
  evaluateBareTagSafety,
  parseReleaseClaims,
  evaluateChangelogDelivery,
  checkRepo,
  SEMVER_PATTERN,
  VERSION_FILE,
  CHANGELOG_FILE,
};

if (require.main === module) {
  main();
}
