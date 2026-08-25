#!/bin/bash
set -euo pipefail

# Live regression and counterprobe for NIL-574. The exact release history is
# intentional: an invented one-PR-per-SHA fixture cannot reproduce the bug.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${RELEASE_NOTES_TEST_REPO:-davifernan/excalidash}"
RANGE="v0.7.0-nilo.4..v0.8.0"
COLLECTED_MERGE="99a03699635d6c66eb02e88a989104a7441c64e6"
UNREPAIRED_REF="${RELEASE_NOTES_UNREPAIRED_REF:-23946a935b0ad22053b62ba9a15d7489366050d6}"
EXPECTED_134="PDF, Markdown/text and sticky-note controls now appear in a viewport-sized toolbar beside the single selected element."
TMP_DIR="$(mktemp -d)"
OLD_COLLECTOR="$ROOT/scripts/.release-notes-unrepaired.$$.cjs"
trap 'rm -rf "$TMP_DIR"; rm -f "$OLD_COLLECTOR"' EXIT

cd "$ROOT"

if ! git rev-list "$RANGE" | grep -Fxq "$COLLECTED_MERGE"; then
  echo "FAIL: $RANGE does not contain the required real collected merge $COLLECTED_MERGE"
  exit 1
fi

echo "=== GREEN: repaired resolver on the exact v0.8.0 history ==="
node --test --test-name-pattern='real v0.8.0 collected merge' scripts/release-notes-collect.test.cjs

LIVE_134_MERGE="$(gh pr view 134 --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid')"
if [ "$LIVE_134_MERGE" != "$COLLECTED_MERGE" ]; then
  echo "FAIL: live PR #134 points at $LIVE_134_MERGE, expected collected merge $COLLECTED_MERGE"
  exit 1
fi

RELEASE_NOTES_REPO="$REPO" \
RELEASE_NOTES_PREVIOUS_REF="v0.7.0-nilo.4" \
RELEASE_NOTES_HEAD_REF="v0.8.0" \
node scripts/release-notes-collect.cjs >"$TMP_DIR/notes.md" 2>"$TMP_DIR/warnings.txt"

RELEASE_NOTES_REPO="$REPO" \
RELEASE_NOTES_PREVIOUS_REF="v0.7.0-nilo.4" \
RELEASE_NOTES_HEAD_REF="v0.8.0" \
node scripts/release-notes-collect.cjs >"$TMP_DIR/notes-second.md" 2>"$TMP_DIR/warnings-second.txt"

if ! cmp -s "$TMP_DIR/notes.md" "$TMP_DIR/notes-second.md" ||
  ! cmp -s "$TMP_DIR/warnings.txt" "$TMP_DIR/warnings-second.txt"; then
  echo "FAIL: two live collection runs over $RANGE produced different output"
  diff -u "$TMP_DIR/notes.md" "$TMP_DIR/notes-second.md" || true
  diff -u "$TMP_DIR/warnings.txt" "$TMP_DIR/warnings-second.txt" || true
  exit 1
fi

if ! grep -Fxq -- "- $EXPECTED_134" "$TMP_DIR/notes.md"; then
  echo "FAIL: the live collection omitted PR #134's exact User-Facing sentence"
  exit 1
fi
for pr in 125 126 129 130; do
  if ! grep -Eq "^SKIP  #${pr}: no usable User-Facing sentence" "$TMP_DIR/warnings.txt"; then
    echo "FAIL: real PR #$pr has User-Facing: none but produced no visible SKIP warning"
    exit 1
  fi
done
echo "PASS: two live runs agree, #134 is present, and real non-user-facing PRs emit SKIP warnings."

echo
echo "=== RED: the same exact-history test against the unrepaired collector ==="
git show "$UNREPAIRED_REF:scripts/release-notes-collect.cjs" >"$OLD_COLLECTOR"
if RELEASE_NOTES_COLLECTOR_UNDER_TEST="$OLD_COLLECTOR" \
  node --test --test-name-pattern='real v0.8.0 collected merge' scripts/release-notes-collect.test.cjs \
  >"$TMP_DIR/red.out" 2>&1; then
  echo "FAIL: the regression test also passed against unrepaired $UNREPAIRED_REF; it proves nothing"
  cat "$TMP_DIR/red.out"
  exit 1
fi
grep -E 'not ok|AssertionError|#134' "$TMP_DIR/red.out" | head -20 || true
echo "CONFIRMED RED: the exact-history regression fails against unrepaired $UNREPAIRED_REF."

echo
echo "release-notes-collect.test.sh: PASS (real range, #134, visible SKIP, and unrepaired counterprobe proven)"
