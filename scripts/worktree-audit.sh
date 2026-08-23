#!/usr/bin/env bash
# Worktree-Konsolidierungs-Routine (NIL-369).
#
# Berichtet, welche registrierten Git-Worktrees des Fork-Repos verwaist sind,
# und entfernt NICHTS von selbst. Löschentscheidungen bleiben Handarbeit --
# siehe docs/architecture/WORKTREE_CONSOLIDATION.md für die Begründung dieser
# Reihenfolge und die zuletzt ausgeführte Runde.
#
# Nutzung:
#   scripts/worktree-audit.sh                 # nur Bericht
#   scripts/worktree-audit.sh --remove <pfad>  # einen konkreten, geprüften Worktree entfernen
#
# Ein Worktree gilt hier als Kandidat für "verwaist", wenn ALLE drei zutreffen:
#   1. kein Prozess hat ihn aktuell als cwd (/proc/*/cwd)
#   2. `git status --porcelain` ist leer (node_modules ausgenommen)
#   3. sein Branch-Kopf ist entweder MERGED/CLOSED laut `gh pr list`, oder er
#      hat keine Commits, die nicht schon auf fork/main liegen
#
# Das Skript prüft (1) und (2) automatisch und maschinell. (3) erfordert einen
# GitHub-API-Aufruf pro Branch und wird nur mit --with-pr-status ausgeführt,
# weil er bei 40+ Worktrees spürbar dauert und ein Ratenlimit treffen kann.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WITH_PR_STATUS=0
REMOVE_PATH=""
for arg in "$@"; do
  case "$arg" in
    --with-pr-status) WITH_PR_STATUS=1 ;;
    --remove) REMOVE_NEXT=1 ;;
    *)
      if [ "${REMOVE_NEXT:-0}" = "1" ]; then REMOVE_PATH="$arg"; REMOVE_NEXT=0; fi
      ;;
  esac
done

is_live() {
  local target="$1"
  for pid_dir in /proc/[0-9]*; do
    local cwd
    cwd=$(readlink -f "$pid_dir/cwd" 2>/dev/null) || continue
    case "$cwd" in
      "$target"|"$target"/*) return 0 ;;
    esac
  done
  return 1
}

is_dirty() {
  local target="$1"
  local n
  n=$(git -C "$target" status --porcelain 2>/dev/null | grep -v '^?? node_modules/$' | wc -l)
  [ "$n" -gt 0 ]
}

if [ -n "$REMOVE_PATH" ]; then
  echo "Letzte Prüfung vor dem Entfernen von $REMOVE_PATH:"
  if is_live "$REMOVE_PATH"; then
    echo "  ABBRUCH: mindestens ein Prozess hat cwd darin. Nicht anfassen."
    exit 1
  fi
  if is_dirty "$REMOVE_PATH"; then
    echo "  ABBRUCH: unsauberer Status. Erst prüfen, was dort liegt (git -C \"$REMOVE_PATH\" status)."
    exit 1
  fi
  echo "  live=nein dirty=nein -- git worktree remove wird ausgeführt."
  git worktree remove "$REMOVE_PATH"
  exit 0
fi

printf '%-70s %-8s %-6s %-10s\n' "WORKTREE" "BRANCH" "LIVE" "DIRTY"
git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
  branch=$(git -C "$wt" branch --show-current 2>/dev/null)
  [ -z "$branch" ] && branch="(detached)"
  live="nein"; is_live "$wt" && live="JA -- anfassen"
  dirty="nein"; is_dirty "$wt" && dirty="ja"
  status=""
  if [ "$WITH_PR_STATUS" = "1" ] && [ "$branch" != "(detached)" ]; then
    status=$(gh pr list --repo davifernan/excalidash --head "$branch" --state all \
      --json state --jq '.[0].state // "no-pr"' 2>/dev/null || echo "?")
  fi
  printf '%-70s %-8s %-6s %-10s %s\n' "$wt" "$branch" "$live" "$dirty" "$status"
done

echo
echo "Entfernen erst nach Prüfung: scripts/worktree-audit.sh --remove <pfad>"
echo "PR-Status pro Branch mitprüfen (kostet Zeit/API-Calls): --with-pr-status"
