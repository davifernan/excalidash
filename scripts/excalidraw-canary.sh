#!/usr/bin/env bash
# Repeatable Excalidraw canary-upgrade routine (NIL-340, M1 close-out).
#
# NIL-368 (M6.1, in main) built the structural pieces this script drives:
# frontend/src/integrations/excalidraw/compatibility/seams.ts declares the
# exports, imperative-API methods and DOM selectors this application expects,
# and verifySeams() checks whatever package is actually installed against
# that list -- it never cared which version that was. What NIL-368 did NOT
# leave behind is a command that actually installs a different version and
# runs that check against it, then puts the pinned version back. This is
# that command.
#
# The question this script has to answer honestly, not just report on:
# "what does this check do when it cannot tell?" A canary run that reports
# green because npm never actually installed the target version, or because
# restoring the pinned version afterwards silently failed and left the repo
# on a moving target, is worse than no canary run -- it spends the trust a
# real green run earns. So every exit path below is one of exactly three
# outcomes, never silently collapsed into another:
#
#   0  ok        -- the target version installed, every seam/contract check
#                    ran, and none of them found a deviation.
#   1  deviation -- the target version installed and the checks ran, but at
#                    least one seam moved. This is the canary doing its job,
#                    not the canary failing.
#   2  inconclusive -- something about running the check itself failed
#                    (the target version would not install, a check crashed
#                    instead of reporting, or -- the one that matters most --
#                    restoring the pinned version afterwards did not verifiably
#                    succeed). Never reported as ok, never reported as a
#                    deviation: it is its own thing, exactly the distinction
#                    KICKOFF.md's soak guidance asks every check in this
#                    package to keep.
#
# Usage:
#   scripts/excalidraw-canary.sh [target]         # target defaults to the
#                                                  # npm "next" dist-tag
#   scripts/excalidraw-canary.sh --e2e [target]   # also runs the Pflichtpfade
#                                                  # cross-browser subset
#                                                  # (slow; opt in)
#
# Never leaves frontend/package.json or package-lock.json changed on disk,
# on any exit path (see the trap below) -- restored from an explicit file
# copy taken before anything is touched, per KICKOFF.md's "Dateikopie, nie
# git checkout --" rule: this restores the pinned dependency tree even when
# invoked inside a tree that already has unrelated uncommitted changes
# elsewhere, which `git checkout --` would have no business touching.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
SCRATCH="$(mktemp -d)"
RUN_E2E=false
TARGET="next"

for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=true ;;
    *) TARGET="$arg" ;;
  esac
done

log() { printf '[excalidraw-canary] %s\n' "$1"; }

PACKAGE_JSON_BACKUP="$SCRATCH/package.json"
LOCK_BACKUP="$SCRATCH/package-lock.json"
cp "$FRONTEND/package.json" "$PACKAGE_JSON_BACKUP"
cp "$FRONTEND/package-lock.json" "$LOCK_BACKUP"
PACKAGE_JSON_BEFORE_HASH="$(sha256sum "$PACKAGE_JSON_BACKUP" | cut -d' ' -f1)"
LOCK_BEFORE_HASH="$(sha256sum "$LOCK_BACKUP" | cut -d' ' -f1)"

PINNED_VERSION="$(node -p "require('$FRONTEND/package.json').dependencies['@excalidraw/excalidraw']")"
log "pinned version: $PINNED_VERSION"
log "canary target:  $TARGET"

RESTORE_DONE=false
restore_pinned() {
  if [ "$RESTORE_DONE" = true ]; then return; fi
  RESTORE_DONE=true
  log "restoring pinned dependency tree..."
  cp "$PACKAGE_JSON_BACKUP" "$FRONTEND/package.json"
  cp "$LOCK_BACKUP" "$FRONTEND/package-lock.json"
  local after_json after_lock
  after_json="$(sha256sum "$FRONTEND/package.json" | cut -d' ' -f1)"
  after_lock="$(sha256sum "$FRONTEND/package-lock.json" | cut -d' ' -f1)"
  if [ "$after_json" != "$PACKAGE_JSON_BEFORE_HASH" ] || [ "$after_lock" != "$LOCK_BEFORE_HASH" ]; then
    log "RESTORE FAILED: package.json/package-lock.json do not match the pre-canary copy."
    log "Pre-canary copies are at: $PACKAGE_JSON_BACKUP and $LOCK_BACKUP"
    return 1
  fi
  if ! (cd "$FRONTEND" && npm ci --no-audit --no-fund >"$SCRATCH/restore-npm-ci.log" 2>&1); then
    log "RESTORE FAILED: 'npm ci' after restoring package-lock.json did not succeed."
    log "See $SCRATCH/restore-npm-ci.log"
    return 1
  fi
  local installed
  installed="$(cd "$FRONTEND" && node -p "require('./node_modules/@excalidraw/excalidraw/package.json').version" 2>/dev/null || echo "unreadable")"
  if [ "$installed" != "$PINNED_VERSION" ]; then
    log "RESTORE FAILED: node_modules reports version '$installed', expected '$PINNED_VERSION'."
    return 1
  fi
  log "restored: @excalidraw/excalidraw@$installed"
  rm -rf "$SCRATCH"
  return 0
}

INCONCLUSIVE=false
on_exit() {
  local exit_code=$?
  if ! restore_pinned; then
    # A failed restore is never allowed to hide behind whatever exit code
    # the check itself was about to report -- it is the loudest possible
    # outcome, because a canary run that quietly leaves the pinned version
    # swapped is the exact failure mode this script exists to not have.
    echo "[excalidraw-canary] INCONCLUSIVE: restore of the pinned version did not verifiably succeed. Manual recovery needed -- see the RESTORE FAILED lines above." >&2
    exit 2
  fi
  if [ "$INCONCLUSIVE" = true ]; then
    exit 2
  fi
  exit "$exit_code"
}
trap on_exit EXIT

log "installing @excalidraw/excalidraw@$TARGET (not saved to package.json/lock)..."
if ! (cd "$FRONTEND" && npm install "@excalidraw/excalidraw@$TARGET" --no-save --no-audit --no-fund >"$SCRATCH/install.log" 2>&1); then
  log "INSTALL FAILED -- the canary version never actually got installed, so no check below ran against it."
  log "See $SCRATCH/install.log"
  INCONCLUSIVE=true
  exit 2
fi
INSTALLED_VERSION="$(cd "$FRONTEND" && node -p "require('./node_modules/@excalidraw/excalidraw/package.json').version")"
log "installed: @excalidraw/excalidraw@$INSTALLED_VERSION"

log "running seam/contract checks (frontend/src/integrations/excalidraw/compatibility)..."
if ! (cd "$FRONTEND" && npx vitest run src/integrations/excalidraw/compatibility --reporter=verbose >"$SCRATCH/seam-check.log" 2>&1); then
  SEAM_LOG="$SCRATCH/seam-check.log"
  cp "$SEAM_LOG" "$ROOT/excalidraw-canary-seam-report.log"
  log "SEAM/CONTRACT DEVIATION against $INSTALLED_VERSION -- report copied to excalidraw-canary-seam-report.log"
  DEVIATION=true
else
  log "seam/contract checks: clean against $INSTALLED_VERSION"
  DEVIATION=false
fi

if [ "$RUN_E2E" = true ]; then
  log "running Pflichtpfade cross-browser subset (--e2e)..."
  E2E_DIR="$ROOT/e2e"
  CANARY_PORT="${CANARY_BACKEND_PORT:-8299}"
  CANARY_FRONTEND_PORT="${CANARY_FRONTEND_PORT:-6989}"
  if ! (cd "$E2E_DIR" && PORT="$CANARY_PORT" FRONTEND_PORT="$CANARY_FRONTEND_PORT" \
      npx playwright test --project=firefox --project=webkit \
      sticky-notes sticky-connect invite-here small-windows document-pages \
      follow-mode canvas-chrome native-export \
      >"$SCRATCH/e2e-check.log" 2>&1); then
    cp "$SCRATCH/e2e-check.log" "$ROOT/excalidraw-canary-e2e-report.log"
    log "CROSS-BROWSER DEVIATION against $INSTALLED_VERSION -- report copied to excalidraw-canary-e2e-report.log"
    DEVIATION=true
  else
    log "cross-browser Pflichtpfade subset: clean against $INSTALLED_VERSION"
  fi
else
  log "skipping --e2e (not requested); seam/contract result above is this run's only signal"
fi

if [ "$DEVIATION" = true ]; then
  exit 1
fi
exit 0
