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
# LIVE hat drei Werte, nicht zwei: "nein" (jede lesbare cwd geprüft, keine
# passt), "JA -- anfassen" (eine passt), "UNKLAR -- prüfen" (mindestens ein
# Prozess existiert, dessen cwd wir nicht lesen durften -- andere UID, meist
# root via systemd oder eine fremde Sitzung). Auf dieser Mehrbenutzer-Maschine
# ist UNKLAR der Normalfall, nicht die Ausnahme: praktisch immer läuft
# irgendein root-Prozess, dessen cwd wir nicht sehen. Das ist gewollt lauter
# als ein glattes "nein" -- ein still verschluckter Lesefehler ist genau der
# Fehler, den dieses Skript nicht wiederholen darf (siehe Memory
# feedback_gegenprobe_blinder_fleck.md). Bei UNKLAR: `sudo ls -la
# /proc/*/cwd | grep <pfad>` von Hand, dann entscheiden -- --remove verweigert
# in diesem Fall von selbst.
#
# Ein Worktree gilt hier als Kandidat für "verwaist", wenn ALLE drei zutreffen:
#   1. jeder Prozess, dessen cwd lesbar war, hat ihn NICHT als cwd -- und
#      keiner war unlesbar (LIVE = "nein", nicht "UNKLAR")
#   2. `git status --porcelain` ist leer
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

# Three outcomes, not two -- collapsing "can't tell" into "nothing there" is
# the same mistake adapter-boundary.cjs and authz-boundary.cjs each made in
# this repo already (see docs/architecture -- both guardrails read "0
# exceptions" over a real, live violation because an unmatched case fell
# through to the harmless answer instead of raising it). Sets LIVE_STATE to
# exactly one of:
#   here      -- a process's cwd resolves inside $target
#   elsewhere -- every process's cwd was readable and none matched
#   unknown   -- at least one process exists whose cwd we could not read
# /proc/PID/cwd is owner-only, so a process under a different UID (root via
# systemd, another user's session) fails readlink exactly like a process that
# no longer exists -- but /proc/PID itself stays world-stat-able even when
# /proc/PID/cwd is not, so "process is gone" stays distinguishable from
# "process exists, cwd unreadable". "unknown" must never be silently treated
# as "elsewhere": that is precisely the case this check exists to catch --
# some other UID's process sitting in the worktree we are about to delete.
is_live() {
  local target="$1"
  local saw_unreadable=0
  local pid_dir cwd
  for pid_dir in /proc/[0-9]*; do
    if cwd=$(readlink -f "$pid_dir/cwd" 2>/dev/null); then
      case "$cwd" in
        "$target"|"$target"/*) LIVE_STATE="here"; return ;;
      esac
    elif [ -d "$pid_dir" ]; then
      saw_unreadable=1
    fi
  done
  if [ "$saw_unreadable" -eq 1 ]; then
    LIVE_STATE="unknown"
  else
    LIVE_STATE="elsewhere"
  fi
}

# node_modules/ is a blanket .gitignore rule (not just under frontend/backend),
# so `git status --porcelain` never lists it anywhere in the tree -- there is
# nothing here to filter. Kept as a no-op guard against a future .gitignore
# narrowing, not because it currently does anything.
is_dirty() {
  local target="$1"
  local n
  n=$(git -C "$target" status --porcelain 2>/dev/null | wc -l)
  [ "$n" -gt 0 ]
}

if [ -n "$REMOVE_PATH" ]; then
  echo "Letzte Prüfung vor dem Entfernen von $REMOVE_PATH:"
  is_live "$REMOVE_PATH"
  case "$LIVE_STATE" in
    here)
      echo "  ABBRUCH: mindestens ein Prozess hat cwd darin. Nicht anfassen."
      exit 1
      ;;
    unknown)
      echo "  ABBRUCH: mindestens ein Prozess konnte nicht geprüft werden (cwd nicht lesbar,"
      echo "  vermutlich andere UID -- root via systemd, fremde Sitzung). Das ist nicht"
      echo "   'nichts da', sondern 'nicht feststellbar'. Manuell mit sudo prüfen"
      echo "  (z.B. sudo ls -la /proc/*/cwd | grep \"$REMOVE_PATH\"), erst dann entscheiden."
      exit 1
      ;;
  esac
  if is_dirty "$REMOVE_PATH"; then
    echo "  ABBRUCH: unsauberer Status. Erst prüfen, was dort liegt (git -C \"$REMOVE_PATH\" status)."
    exit 1
  fi
  echo "  live=nein (verifiziert, kein unlesbarer Prozess) dirty=nein -- git worktree remove wird ausgeführt."
  git worktree remove "$REMOVE_PATH"
  exit 0
fi

printf '%-70s %-8s %-10s %-10s\n' "WORKTREE" "BRANCH" "LIVE" "DIRTY"
git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
  branch=$(git -C "$wt" branch --show-current 2>/dev/null)
  [ -z "$branch" ] && branch="(detached)"
  is_live "$wt"
  case "$LIVE_STATE" in
    here) live="JA -- anfassen" ;;
    unknown) live="UNKLAR -- prüfen" ;;
    *) live="nein" ;;
  esac
  dirty="nein"; is_dirty "$wt" && dirty="ja"
  status=""
  if [ "$WITH_PR_STATUS" = "1" ] && [ "$branch" != "(detached)" ]; then
    status=$(gh pr list --repo davifernan/excalidash --head "$branch" --state all \
      --json state --jq '.[0].state // "no-pr"' 2>/dev/null || echo "?")
  fi
  printf '%-70s %-8s %-10s %-10s %s\n' "$wt" "$branch" "$live" "$dirty" "$status"
done

echo
echo "Entfernen erst nach Prüfung: scripts/worktree-audit.sh --remove <pfad>"
echo "PR-Status pro Branch mitprüfen (kostet Zeit/API-Calls): --with-pr-status"
