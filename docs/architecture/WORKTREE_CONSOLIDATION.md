# Worktree-Konsolidierung

Status: wiederholbare Routine, keine Einmalaktion
Skript: [`scripts/worktree-audit.sh`](../../scripts/worktree-audit.sh)
Auftrag: NIL-369 (Acceptance Slice von NIL-327)

## Warum das ein eigenes Dokument ist

Diese Maschine ist am 08.07.2026 an OOM gestorben (16 GB RAM, ~30 Docker-Container plus
bare-metal-Prozesse plus der Nilo-Stack). Jeder laufende `npm run dev` in einem vergessenen
Worktree ist RAM, das beim nächsten Engpass fehlt. Ein Worktree, der nicht mehr gebraucht wird,
aber stehen bleibt, kostet niemandem sofort etwas -- bis eine Welle mit vier neuen langlebigen
Worktrees startet und niemand mehr weiß, welcher der 46 vorhandenen noch etwas bedeutet.

## Die Routine

1. `scripts/worktree-audit.sh` -- listet jeden registrierten Worktree mit Branch, ob ein
   Prozess gerade `cwd` darin hat, und ob `git status` etwas meldet. Die Prozessprüfung kennt
   drei Zustände, nicht zwei: `nein`, `JA -- anfassen`, und `UNKLAR -- prüfen` für jeden
   Prozess, dessen `/proc/PID/cwd` wir mangels Rechten (andere UID, meist root) gar nicht lesen
   konnten -- ein Lesefehler wird nie stillschweigend als "nichts da" gewertet.
2. `scripts/worktree-audit.sh --with-pr-status` -- zusätzlich der PR-Zustand jedes Branches
   über `gh pr list`. Läuft separat, weil es bei vielen Worktrees API-Zeit kostet.
3. Ein Worktree ist erst dann ein Löschkandidat, wenn **alle drei** zutreffen:
   - kein Prozess hat ihn als `cwd`, **und** keiner war unlesbar (`nein`, nicht `UNKLAR`)
   - `git status --porcelain` ist leer
   - sein Branch ist entweder MERGED/CLOSED, oder er hat keine Commits, die nicht schon auf
     `fork/main` liegen (`git log --oneline fork/main..<branch>` ist leer)
4. **Vor jedem Entfernen erneut prüfen, nicht nur einmal am Anfang.** Zwischen der ersten und
   der zweiten Prüfungsrunde in dieser Ausführung ist ein neuer Worktree
   (`nil-323-worktree`, NIL-323, parallele Welle 1) live entstanden und dirty geworden -- ein
   Snapshot vom Rundenbeginn wäre falsch gewesen.
5. `git worktree remove <pfad>` entfernt **nur den Checkout**, nicht den Branch. Der Branch
   bleibt im gemeinsamen `.git` von `excalidash-alpha` erhalten, solange er nicht separat mit
   `git branch -D` gelöscht wird. Das senkt das Risiko erheblich: ein entfernter Worktree ist
   jederzeit mit `git worktree add <neuer-pfad> <branch>` wiederherstellbar.
6. Ein Branch, der **nur lokal** existiert (kein `own/<branch>` auf dem Remote), sollte vor dem
   Entfernen seines Worktrees gepusht werden -- sonst hängt sein einziger Zugriffspfad an einem
   Worktree, den gerade jemand aufräumt.

## Was diese Runde ergeben hat (23.08.2026)

Bestand vorher: 46 registrierte Worktrees (`git worktree list`, `excalidash-alpha` als
Git-Dir-Eigentümer) plus 19 in `multica_workspaces/` (bereits in der Gesamtzahl enthalten) plus
13 Scratchpad-Worktrees anderer, teils laufender Sitzungen unter `/tmp/claude-*/scratchpad/`.

**26 entfernt:**

- 16 unter `/home/claude/excalidash-*`: durchweg Branches, deren PR laut `gh pr list --state
  all` bereits MERGED war (`excalidash-m0`, `-m1`, `-nil-385`, `-nil-480`, `-nil-483`,
  `-nil-485`, `-integrate-nil-385`, `-assets`), oder deren Branch-Kopf null Commits gegenüber
  `fork/main` hatte (`-control-master`, `-control-pr`, `-integration`, `-review`, `-nil-412`,
  `-nil-404-sentinel`), oder deren PR CLOSED war und dessen Commits auf einem anderen,
  gemergten Branch desselben Tickets bereits vorhanden waren (`-sentinel-incident`, dessen
  Inhalt auch remote unter `own/fix/nil-321-sentinel-liveness` liegt).
- 19 in `multica_workspaces/`: jeder einzelne Branch dort hatte laut `gh pr list` einen
  terminalen PR-Zustand (MERGED oder CLOSED), keiner einen laufenden Prozess.
- 9 Scratchpad-Worktrees einer Sitzung ohne laufenden Prozess (`454c469e-...`), zwei davon mit
  Rot-Proben-Testmodifikationen (`wtred`, `wt37red` -- Muster der `git-checkout---`-Warnung aus
  den Betriebsregeln: nicht `checkout --`, sondern der ganze Wegwerf-Worktree ist hier das
  Objekt, das entfernt wird, keine einzelne Datei innerhalb eines noch gebrauchten Checkouts).

**2 Branches ohne Remote-Tracking gefunden und zur Sicherheit gepusht, bevor ihr Worktree
angefasst wurde** (siehe oben, Punkt 6): `fix/nil-413-error-path-visibility` (PR #44 CLOSED, 3
Commits, ausschließlich lokal) und `feat/link-cards` (nie ein PR eröffnet, 3 Commits
inklusive Merge, ausschließlich lokal). Beide Worktrees bleiben stehen -- das ist echte,
unlandete Arbeit, keine Aufräum-Entscheidung.

**Bewusst nicht angefasst** (Begründung siehe `PACKAGE CLAIM` auf NIL-327):

| Worktree | Grund |
|---|---|
| `excalidash-live` | `nilo/live`, siehe [nilo/live-Abschnitt](./UPSTREAM_MAINTENANCE.md#nilolive-vs-main) |
| `excalidash-nil-376`, `nil-323-worktree` | parallele Wave-1-Tracks, laufende Server bzw. dirty |
| `excalidash-mig-a-sticky/b-commands/c-collab/e-stubs`, `excalidash-m1-int` | aktiver Orchestrierungs-Loop einer fremden, laufenden Sitzung |
| `excalidash-m1-final` | laufende Dev-Server, Eigentümer unklar -- nicht ohne Rückfrage anfassen |
| `excalidash-mainref` | bewusst als saubere Main-Referenz behalten (Detached HEAD auf `fork/main`-Spitze, für schnelle Diffs) |
| `excalidash-source` | 46 STAGED, nie committete Änderungen auf Branch `main` -- sieht nach einem begonnenen Delivery-V2-Rollback aus. Produktentscheidung, kein Aufräumfall. Separat auf NIL-327 kommentiert. |
| `excalidash-redprobe-317` | ein untracked Testfile für eine Rot-Probe zu NIL-317, das in `main` in dieser Form nicht existiert -- möglich verlorene Testabdeckung, absichtlich stehen gelassen statt gelöscht |
| Scratchpad-Worktrees der Sitzungen `93b5af3a…` und `f0bff424…` | beide zum Prüfzeitpunkt aktiv (laufende Prozesse, Transkript-Updates innerhalb der letzten Stunde) |
| `.../c3a99ee6…/scratchpad/recon` | kein laufender Prozess, aber Aktivität am selben Tag ohne eindeutiges Ende -- im Zweifel stehen gelassen |

Ergebnis: 46 → 20 registrierte Worktrees (`git worktree list | wc -l`).

**Nachträglich mit `sudo` verifiziert:** Die Live-Prüfung während dieser Runde lief ohne
Root-Rechte und hätte damit -- wie in `scripts/worktree-audit.sh` inzwischen behoben -- jeden
Prozess einer fremden UID (root via systemd, andere Sitzung) fälschlich als "kein Prozess"
gelesen. Ein Root-Sweep über `/proc/*/cwd` nach der Runde zeigt: **jeder** Prozess mit `cwd`
unter `excalidash-*` oder `multica_workspaces/` gehört Nutzer `claude`, keiner root oder einem
anderen Konto. Die 26 Entfernungen waren damit faktisch sicher -- aber durch Glück (gleiche UID
auf dieser Maschine heute), nicht durch die Prüfung selbst. Das ist der Grund, warum der Fix in
`worktree-audit.sh` bleibt: die nächste Runde hat dieses Glück nicht garantiert.

## Nachmessung zweier nicht registrierter Pfade (24.08.2026)

NIL-529 und NIL-530 entstanden aus der Runde oben, waren aber keine normalen
`git worktree`-Kandidaten: der erste Pfad hatte sein `.git` bereits verloren, der zweite war
für den Host-Nutzer nicht lesbar. Vor der Messung zeigte `herdr agent list`, dass keine andere
aktive Sitzung einen der beiden Pfade als Worktree benutzte.

### `/home/claude/ex-498` und seine Sicherung

Die Vergleichsbasis war nicht ein Zeitstempel, sondern der über GitHub bestätigte Merge-Commit
von PR #71, `bd9e6ca637a792bed0930577eab09e81301a829b`, in einem sauberen detached Checkout. Beide
Restbäume wurden mit demselben Befehl geprüft:

```bash
diff -rq <restbaum> <sauberer-pr-71-checkout> --exclude node_modules --exclude .git
```

Sowohl `/home/claude/ex-498` als auch
`/home/claude/excalidash-kickoffs/ex-498-rest` ergaben vier abweichende Dateien:

- `e2e/Dockerfile.playwright`
- `e2e/README.md`
- `e2e/playwright.config.ts`
- `frontend/package.json`

Drei Einträge existierten nur in den Restbäumen: `KICKOFF.md`,
`e2e/playwright-retry-summary-reporter.cjs` und `frontend/public/fonts/`. Inhalt und
Git-Historie ordnen die E2E-/Package-Abweichungen dem älteren Stand vor `183f712` (Retries auf
null und Reporter entfernt) beziehungsweise `e99fa0b` (ungenutzten Frontend-Playwright-Runner
entfernt) zu. Keine nicht ausgeschlossene Datei hatte einen Änderungszeitpunkt nach dem Merge
von PR #71. Das erklärt die Herkunft, ist aber keine Löschfreigabe.

Der direkte Vergleich zwischen Original und Sicherung mit denselben Ausschlüssen endete mit
Exit-Code 0 und ohne Ausgabe. Beide enthalten 293 Dateien mit zusammen 13.417.803 Bytes. Damit
ist der Restbestand vollständig und bytegleich gesichert. Weil der Vergleich gegen PR #71
echte Abweichungen zeigte, wurden **weder** `/home/claude/ex-498` **noch** seine Sicherung
gelöscht oder verändert. Das ist der im Auftrag festgelegte Sicherungsfall, nicht der
Teilmengenfall.

### `/home/claude/excalidash-backups`

Der nur über `sudo` lesbare Pfad ist kein verwaister Fremdrest. Der laufende
`excalidash-backend`-Prozess läuft als UID 1001 und bind-mountet genau diesen Hostpfad nach
`/app/backups`. Damit sind Eigentümer `1001:1001`, Verzeichnismodus `0700` und Dateimodus
`0600` für die enthaltenen Produktionsdaten beabsichtigt.

Gemessen wurden 26 MiB und vier Dateien: zwei vollständige ZIP-Archive sowie ein
32-KiB-`.sqlite.part-shm` und ein leeres `.sqlite.part-wal`. Beide Archive bestanden
`unzip -t`; ihre Manifeste sind `excalidash-server-backup` in Formatversion 2 und enthalten
jeweils die SQLite-Datenbank, fünf beziehungsweise sieben persistierte Original-Assets sowie
die persistenten JWT-/CSRF-Secretdateien. Die Secretwerte wurden nicht ausgegeben. Temporäre,
einzeln benannte Kopien beider Datenbanken bestanden außerdem `PRAGMA quick_check` mit `ok` und
enthielten jeweils 22 Anwendungstabellen.

Die Produktionskonfiguration plant täglich um 03:00 Uhr ein Backup, hält höchstens sieben
Archive beziehungsweise 30 GiB vor und warnt nach 48 Stunden ohne erfolgreiches Backup. Der
Readiness-Endpunkt meldete das Archiv vom 24.08.2026 03:00 Uhr als aktuell und gesund. Die zwei
Sidecars stammen vom deployten Image auf Commit `21545d7`; der bereits auf `main` vorhandene
Fix `a7a2579` entfernt solche Sidecars und räumt ältere Reste nach 24 Stunden auf, ist aber noch
nicht in diesem Produktionsimage.

Folge: `/home/claude/excalidash-backups` ist aktiver, sensibler Wiederherstellungsbestand und
wurde weder gelöscht noch umberechtigt. Auch die erklärten Sidecars blieben für die normale
Anwendungsbereinigung unangetastet; eine weitergehende Aufbewahrungsentscheidung gehört dem
Betreiber.

## Wann als Nächstes prüfen

Nicht auf einen Kalender legen -- vor jeder neuen Welle mit mehreren langlebigen Package-
Worktrees (wie Welle 1) und danach, wenn ein Package auf `done` geht. Der Bestand wächst durch
neue Ownership Packages und Rot-Proben-Scratchpads schneller, als er von selbst schrumpft.
