#!/usr/bin/env bash
# Worktree-Konsolidierungs-Routine (NIL-369).
#
# Berichtet, welche registrierten Git-Worktrees des Fork-Repos verwaist sind,
# und entfernt NICHTS von selbst. Löschentscheidungen bleiben Handarbeit --
# siehe docs/architecture/WORKTREE_CONSOLIDATION.md für die Begründung dieser
# Reihenfolge und die zuletzt ausgeführte Runde.
#
# Nutzung:
#   scripts/worktree-audit.sh                    # nur Bericht
#   scripts/worktree-audit.sh --remove <pfad>     # einen konkreten, geprüften Worktree entfernen
#   scripts/worktree-audit.sh --classify <comm>          # Testhaken, siehe worktree-audit.test.cjs
#   scripts/worktree-audit.sh --debug-live-state <pfad>  # Testhaken
#   scripts/worktree-audit.sh --debug-dirty-state <pfad> # Testhaken
#
# EIN Prinzip für die ganze Datei: jede Prüfung, die etwas feststellt, kennt
# drei Ausgänge -- ja / nein / konnte nicht nachsehen -- und "konnte nicht
# nachsehen" ist nie derselbe Fall wie "nein". Ein still verschluckter
# Lesefehler ist genau der Fehler, den adapter-boundary.cjs und
# authz-boundary.cjs in diesem Repo schon einmal gemacht haben: beide
# meldeten "0 Ausnahmen" über einer echten, lebenden Verletzung, weil ein
# nicht abgedeckter Fall auf die harmlose Antwort fiel (siehe Memory
# feedback_gegenprobe_blinder_fleck.md). Dieses Skript hatte dieselbe Form
# zweimal: `is_live()` las "cwd nicht lesbar" als "nichts da", und
# `is_dirty()` las "git ist fehlgeschlagen" als "sauber". Und einmal in die
# GEGENTEILIGE Richtung: die erste Reparatur von `is_live()` machte "konnte
# nicht nachsehen" zum Normalfall (über 550 fremde /proc-Einträge auf diesem
# Mehrbenutzer-Host) und damit "nein" praktisch unerreichbar -- sicher und
# nutzlos ist auch keine Prüfung, weil ein Zweifelsfall, der immer eintritt,
# nichts mehr unterscheidet.
#
# LIVE hat drei Werte: "nein" (jeder relevante Prozess war lesbar, keiner
# passt), "JA -- anfassen" (einer passt), "UNKLAR -- prüfen" (mindestens ein
# NICHT als Infrastruktur erkannter Prozess existiert, dessen cwd wir nicht
# lesen durften). "Infrastruktur" heißt hier: strukturell erkennbar als
# etwas, das nie eine cwd innerhalb eines Git-Worktrees hat -- Kernel-Thread
# (leere /proc/PID/cmdline), Dienstkonto (UID 1-999) oder ein eindeutig
# benannter root-Daemon (siehe `_is_infra_by_signals`). Root selbst und jede
# reguläre UID ab 1000 -- einschließlich `claude` -- werden NIE
# freigesprochen: comm-Namen wie `node`/`python`/`bash`/`sh` sind zu generisch,
# um einen fremden Dev-Server von einem eigenen zu unterscheiden. Für jeden
# so übrig gebliebenen Prozess wird PID, Nutzer und comm genannt statt eines
# pauschalen "irgendwas war unlesbar".
#
# DIRTY hat dieselben drei Werte, aus `is_dirty_state()`: "nein"/"ja" wenn
# `git status --porcelain` durchlief, "UNKLAR" wenn git selbst fehlschlug
# (Verzeichnis weg, kaputter Worktree-Zeiger, fehlende Rechte) -- ein
# Git-Fehler ist keine Aussage über Sauberkeit, sondern das Fehlen einer.
#
# Ein falsch benutztes Argument (`--remove` ohne folgenden Pfad) ist ein
# Fehler mit Meldung und Exitcode 2, kein stiller Rückfall in den Bericht.
#
# Ein Worktree gilt hier als Kandidat für "verwaist", wenn ALLE drei zutreffen:
#   1. LIVE = "nein" (nicht "UNKLAR")
#   2. DIRTY = "nein" (nicht "UNKLAR")
#   3. sein Branch-Kopf ist entweder MERGED/CLOSED laut `gh pr list`, oder er
#      hat keine Commits, die nicht schon auf fork/main liegen
#
# Das Skript prüft (1) und (2) automatisch und maschinell. (3) erfordert einen
# GitHub-API-Aufruf pro Branch und wird nur mit --with-pr-status ausgeführt,
# weil er bei 40+ Worktrees spürbar dauert und ein Ratenlimit treffen kann.

set -euo pipefail

# Curated, ausschließlich für root-Prozesse mit eindeutigem, etabliertem
# Namen -- NICHT für generische Interpreter (node/python/bash/sh/npm/sleep),
# weil ein echter Excalidash-Dev-Server denselben comm-Namen trägt wie ein
# fremder auf diesem Mehrbenutzer-Host. Diese Liste NIE um generische Namen
# erweitern -- dafür gibt es die beiden anderen, listenfreien Signale in
# _is_infra_by_signals().
_INFRA_PROCESS_NAMES=(
  docker-proxy containerd-shim dockerd postgres mariadbd nginx sshd
  avahi-daemon wpa_supplicant watchdogd unattended-upgr udisksd agetty su
  systemd systemd-udevd systemd-timesyn systemd-resolve systemd-network
  systemd-logind systemd-journal "(sd-pam)" s6-supervise s6-svscan
  s6-linux-init-s s6-ipcserverd scsi_eh_0 scsi_eh_1 psimon MainThread
  cron rsyslogd dbus-daemon ModemManager multipathd polkitd
)

_is_infra_process_name() {
  local comm="$1"
  case "$comm" in
    kworker/*) return 0 ;;
  esac
  local name
  for name in "${_INFRA_PROCESS_NAMES[@]}"; do
    [ "$comm" = "$name" ] && return 0
  done
  return 1
}

# Drei listenfreie/listenbasierte Signale, in aufsteigender Unschärfe. Ein
# Prozess mit unlesbarer cwd gilt nur dann als Infrastruktur, wenn EINES
# zutrifft -- alles andere bleibt "relevant" und macht LIVE_STATE laut, nicht
# still:
#   1. leere /proc/PID/cmdline -- ein Kernel-Thread hat keine. Strukturell,
#      keine Namensliste kann mit `kworker/N:M`, `rcu_*`, `ksoftirqd/N`,
#      `migration/N`, `cpuhp/N`, ... mithalten, und muss es damit auch nicht.
#   2. Eigentümer-UID 1-999 -- die Debian/Ubuntu-Konvention für
#      Dienstkonten (www-data, syslog, mysql, messagebus, polkitd, ...), die
#      keine interaktiven Dev-Server starten. UID 0 (root) und jede UID
#      ab 1000 (ein echtes, anmeldefähiges Konto -- einschließlich `claude`
#      selbst) zählt NICHT dazu und bleibt der dritten Prüfung überlassen.
#   3. comm steht auf der oben kuratierten Liste eindeutiger Daemon-Namen.
_is_infra_by_signals() {
  local pid_dir="$1" comm="$2"
  if [ ! -s "$pid_dir/cmdline" ]; then
    return 0
  fi
  local uid
  if uid=$(stat -c '%u' "$pid_dir" 2>/dev/null) && [ "$uid" -ge 1 ] && [ "$uid" -lt 1000 ]; then
    return 0
  fi
  _is_infra_process_name "$comm"
}

# Setzt LIVE_STATE auf genau einen von "here" / "elsewhere" / "unknown".
# Bei "unknown" steht in LIVE_UNKNOWN_DETAIL eine Zeile pro betroffenem
# Prozess (pid, Nutzer, comm).
is_live() {
  local target="$1"
  local saw_unreadable_relevant=0
  LIVE_UNKNOWN_DETAIL=""
  local pid_dir cwd pid comm owner
  for pid_dir in /proc/[0-9]*; do
    if cwd=$(readlink -f "$pid_dir/cwd" 2>/dev/null); then
      case "$cwd" in
        "$target"|"$target"/*) LIVE_STATE="here"; return ;;
      esac
    elif [ -d "$pid_dir" ]; then
      comm=$(cat "$pid_dir/comm" 2>/dev/null || echo "?")
      if ! _is_infra_by_signals "$pid_dir" "$comm"; then
        saw_unreadable_relevant=1
        pid="${pid_dir#/proc/}"
        owner=$(stat -c '%U' "$pid_dir" 2>/dev/null || echo "?")
        LIVE_UNKNOWN_DETAIL="${LIVE_UNKNOWN_DETAIL}    pid=$pid user=$owner comm=$comm
"
      fi
    fi
  done
  if [ "$saw_unreadable_relevant" -eq 1 ]; then
    LIVE_STATE="unknown"
  else
    LIVE_STATE="elsewhere"
  fi
}

# Setzt DIRTY_STATE auf genau einen von "clean" / "dirty" / "unknown". Bei
# "unknown" ist git selbst nicht mit Exitcode 0 zurückgekommen (Verzeichnis
# weg, kaputter Worktree-Zeiger, fehlende Rechte) -- DIRTY_ERROR trägt seine
# stderr-Ausgabe. node_modules/ ist eine pauschale .gitignore-Regel (nicht
# nur unter frontend/backend), also listet `status --porcelain` es nirgendwo
# im Baum -- dafür gibt es hier bewusst keinen eigenen Filter.
is_dirty_state() {
  local target="$1"
  local out err_file rc
  err_file=$(mktemp)
  out=$(git -C "$target" status --porcelain 2>"$err_file") && rc=0 || rc=$?
  DIRTY_ERROR=$(cat "$err_file")
  rm -f "$err_file"
  if [ "$rc" -ne 0 ]; then
    DIRTY_STATE="unknown"
  elif [ -n "$out" ]; then
    DIRTY_STATE="dirty"
  else
    DIRTY_STATE="clean"
  fi
}

# Testhaken (siehe scripts/worktree-audit.test.cjs), alle vor REPO_ROOT/cd,
# damit sie ohne Checkout-Kontext laufen.
case "${1:-}" in
  --classify)
    _is_infra_process_name "${2:-}" && echo "infra" || echo "relevant"
    exit 0
    ;;
  --debug-live-state)
    is_live "${2:-}"
    echo "LIVE_STATE=$LIVE_STATE"
    printf '%s' "$LIVE_UNKNOWN_DETAIL"
    exit 0
    ;;
  --debug-dirty-state)
    is_dirty_state "${2:-}"
    echo "DIRTY_STATE=$DIRTY_STATE"
    [ "$DIRTY_STATE" = "unknown" ] && echo "DIRTY_ERROR=$DIRTY_ERROR"
    exit 0
    ;;
esac

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
# Ein missbrauchtes Argument ist ein Fehler, kein stiller Rückfall in den
# Bericht: --remove ohne folgenden Pfad ließ REMOVE_PATH vorher leer, und
# "leer" sieht für den weiteren Code identisch aus wie "--remove wurde nicht
# angegeben" -- das Skript wechselte kommentarlos den Modus.
if [ "${REMOVE_NEXT:-0}" = "1" ]; then
  echo "Fehler: --remove braucht einen Pfad." >&2
  exit 2
fi

if [ -n "$REMOVE_PATH" ]; then
  echo "Letzte Prüfung vor dem Entfernen von $REMOVE_PATH:"
  is_live "$REMOVE_PATH"
  case "$LIVE_STATE" in
    here)
      echo "  ABBRUCH: mindestens ein Prozess hat cwd darin. Nicht anfassen."
      exit 1
      ;;
    unknown)
      echo "  ABBRUCH: mindestens ein nicht als Infrastruktur erkannter Prozess konnte nicht"
      echo "  geprüft werden (cwd nicht lesbar, vermutlich andere UID):"
      printf '%s' "$LIVE_UNKNOWN_DETAIL"
      echo "  Das ist nicht 'nichts da', sondern 'nicht feststellbar'. Manuell mit sudo prüfen"
      echo "  (z.B. sudo readlink -f /proc/<pid>/cwd), erst dann entscheiden."
      exit 1
      ;;
  esac
  is_dirty_state "$REMOVE_PATH"
  case "$DIRTY_STATE" in
    dirty)
      echo "  ABBRUCH: unsauberer Status. Erst prüfen, was dort liegt (git -C \"$REMOVE_PATH\" status)."
      exit 1
      ;;
    unknown)
      echo "  ABBRUCH: git konnte den Status nicht feststellen (Verzeichnis weg, kaputter"
      echo "  Worktree-Zeiger, fehlende Rechte?). Das ist nicht 'sauber', sondern 'nicht"
      echo "  feststellbar'. git-Fehler:"
      echo "$DIRTY_ERROR" | sed 's/^/    /'
      exit 1
      ;;
  esac
  echo "  live=nein (verifiziert) dirty=nein (verifiziert) -- git worktree remove wird ausgeführt."
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
  is_dirty_state "$wt"
  case "$DIRTY_STATE" in
    dirty) dirty="ja" ;;
    unknown) dirty="UNKLAR" ;;
    *) dirty="nein" ;;
  esac
  status=""
  if [ "$WITH_PR_STATUS" = "1" ] && [ "$branch" != "(detached)" ]; then
    status=$(gh pr list --repo davifernan/excalidash --head "$branch" --state all \
      --json state --jq '.[0].state // "no-pr"' 2>/dev/null || echo "?")
  fi
  printf '%-70s %-8s %-10s %-10s %s\n' "$wt" "$branch" "$live" "$dirty" "$status"
  if [ "$LIVE_STATE" = "unknown" ]; then
    printf '%s' "$LIVE_UNKNOWN_DETAIL"
  fi
  if [ "$DIRTY_STATE" = "unknown" ]; then
    echo "$DIRTY_ERROR" | sed 's/^/    git: /'
  fi
done

echo
echo "Entfernen erst nach Prüfung: scripts/worktree-audit.sh --remove <pfad>"
echo "PR-Status pro Branch mitprüfen (kostet Zeit/API-Calls): --with-pr-status"
