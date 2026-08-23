#!/usr/bin/env node
/**
 * Counterprobe for scripts/worktree-audit.sh.
 *
 * Three findings on the same PR, all one shape: a helper that determines
 * something answered confidently where it had not actually looked.
 *
 *   A) is_live() read "cwd unreadable" as "nothing there" -- Hans-Friedrich,
 *      PR #57, first review (head 133df816).
 *   B) is_dirty() read "git itself failed" as "clean" -- Hans-Friedrich,
 *      PR #57, second review (head 24e49ee).
 *   C) `--remove` with no following path silently fell back to report mode
 *      instead of erroring -- Hans-Friedrich, PR #57, second review.
 *
 * And a fourth, the opposite mistake in the first fix for (A): treating
 * "cwd unreadable" as *always* meaning "unknown" made "unknown" the resting
 * state on this multi-tenant host (500+ unrelated processes at any time),
 * which makes `elsewhere` unreachable and `--remove` refuse for every
 * worktree, forever -- safe and useless is not a repair, it is an
 * abolition. Every probe below plants the real defect and requires the
 * fixed script to name it, exactly as adapter-boundary.test.cjs and
 * authz-boundary.test.cjs do for their own checks.
 *
 * The B and C probes reproduce the exact historical function bodies from
 * commit 24e49ee verbatim (verified locally via `git show
 * 24e49ee:scripts/worktree-audit.sh` at authoring time) rather than
 * `git show`-ing them at test time: CI checks out with the default shallow
 * depth, so a commit that is not the PR tip is not guaranteed to be
 * present.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "worktree-audit.sh");

function run(args, opts = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    ...opts,
  });
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "test"]);
}

test("--classify: known infra daemon names are infra", () => {
  for (const comm of ["docker-proxy", "postgres", "containerd-shim", "nginx", "sshd", "systemd"]) {
    const r = run(["--classify", comm]);
    assert.equal(r.stdout.trim(), "infra", `expected ${comm} to classify as infra`);
  }
});

test("--classify: kworker family matches by prefix", () => {
  const r = run(["--classify", "kworker/0:1-events"]);
  assert.equal(r.stdout.trim(), "infra");
});

test("--classify: generic interpreters and unknown binaries default to relevant, never infra", () => {
  // This is the direction that matters: an unrecognized name must never be
  // silently cleared. node/python/bash/sh are deliberately NOT on the infra
  // list -- a real Excalidash dev server has the same comm name as an
  // unrelated one on this host, and comm alone cannot tell them apart.
  for (const comm of ["node", "npm", "bash", "sh", "python3.12", "sleep", "totally-unknown-binary-xyz"]) {
    const r = run(["--classify", comm]);
    assert.equal(r.stdout.trim(), "relevant", `expected ${comm} to classify as relevant, not infra`);
  }
});

test("is_live: a path nobody uses is 'elsewhere', not 'unknown' -- regression guard for the overcorrected first fix", () => {
  // This is the assertion that would have failed against commit 24e49ee on
  // this machine: with no signal narrowing, is_live() there flags "unknown"
  // for virtually any target, because /proc always holds hundreds of
  // processes this session cannot read cwd for (docker-proxy, postgres,
  // containerd-shim, nginx, systemd-*, kernel threads, ...). Live-measured
  // on 2026-08-23: 556 unreadable /proc entries, is_live() unknown for every
  // real target tried. That count is host- and moment-specific, so it is
  // not re-asserted here as a fixed number -- what must hold everywhere is
  // that an unused directory does not trip "unknown".
  const target = mkTempDir("wa-unused-");
  const r = run(["--debug-live-state", target]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^LIVE_STATE=elsewhere$/m);
  fs.rmSync(target, { recursive: true, force: true });
});

test("is_live: a directory holding a real process's cwd is 'here'", () => {
  // Spawned directly (not via `bash -c "... &"`), so the child's parent
  // stays this still-running test process for the probe's duration --
  // going through an intermediate shell that exits right after forking
  // the background job let this session's own process supervision reap it
  // before the check ran, which is an artifact of this sandbox, not of
  // Linux process semantics in general.
  const target = mkTempDir("wa-live-");
  const child = spawn("sleep", ["5"], { cwd: target, stdio: "ignore" });
  try {
    const r = run(["--debug-live-state", target]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^LIVE_STATE=here$/m);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("is_dirty_state: clean checkout reports clean, dirty checkout reports dirty", () => {
  const dir = mkTempDir("wa-git-");
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);

  let r = run(["--debug-dirty-state", dir]);
  assert.match(r.stdout, /^DIRTY_STATE=clean$/m);

  fs.writeFileSync(path.join(dir, "b.txt"), "y");
  r = run(["--debug-dirty-state", dir]);
  assert.match(r.stdout, /^DIRTY_STATE=dirty$/m);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("is_dirty_state: a path where git itself fails is 'unknown', not 'clean' -- Hans-Friedrich medium finding", () => {
  const target = path.join(os.tmpdir(), "wa-does-not-exist-" + process.pid);
  const r = run(["--debug-dirty-state", target]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^DIRTY_STATE=unknown$/m);
  assert.match(r.stdout, /DIRTY_ERROR=.*cannot change to/);
});

test("RED PROBE (B): the historical is_dirty(), reproduced verbatim from commit 24e49ee, reports 'not dirty' for a path git cannot even reach", () => {
  // Exact function body at commit 24e49ee, before this fix. Verified
  // locally via: git show 24e49ee:scripts/worktree-audit.sh
  const historical = `
is_dirty() {
  local target="$1"
  local n
  n=$(git -C "$target" status --porcelain 2>/dev/null | wc -l)
  [ "$n" -gt 0 ]
}
`;
  const target = path.join(os.tmpdir(), "wa-red-probe-b-" + process.pid);
  const r = spawnSync(
    "bash",
    ["-c", `${historical}\nis_dirty "$1" && echo dirty || echo clean`, "_", target],
    { encoding: "utf8" },
  );
  assert.equal(
    r.stdout.trim(),
    "clean",
    "the historical is_dirty() must report 'clean' here -- that is the bug: a git failure read as cleanliness",
  );
});

test("RED PROBE (C): the historical arg loop, reproduced verbatim from commit 24e49ee, silently falls back to report mode on --remove with no path", () => {
  // Exact arg-parsing block at commit 24e49ee. Verified locally via:
  // git show 24e49ee:scripts/worktree-audit.sh
  const historical = `
WITH_PR_STATUS=0
REMOVE_PATH=""
for arg in "$@"; do
  case "$arg" in
    --with-pr-status) WITH_PR_STATUS=1 ;;
    --remove) REMOVE_NEXT=1 ;;
    *)
      if [ "\${REMOVE_NEXT:-0}" = "1" ]; then REMOVE_PATH="$arg"; REMOVE_NEXT=0; fi
      ;;
  esac
done
if [ -n "$REMOVE_PATH" ]; then
  echo "would remove: $REMOVE_PATH"
else
  echo "fell through to report mode"
fi
`;
  const r = spawnSync("bash", ["-c", historical, "_", "--remove"], { encoding: "utf8" });
  assert.equal(
    r.stdout.trim(),
    "fell through to report mode",
    "the historical arg loop must silently switch modes -- that is the bug: a malformed --remove is not an error",
  );
});

test("GREEN (C): --remove with no path is a hard error, not a silent mode switch", () => {
  const r = run(["--remove"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /braucht einen Pfad/);
});

test("--remove refuses on a target git cannot reach, and says why (integration: is_live elsewhere + is_dirty_state unknown -> abort)", () => {
  const target = path.join(os.tmpdir(), "wa-remove-unreachable-" + process.pid);
  const r = run(["--remove", target]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /git konnte den Status nicht feststellen/);
});
