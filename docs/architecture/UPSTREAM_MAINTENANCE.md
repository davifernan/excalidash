# Upstream Maintenance

Status: verbindlicher Wartungsablauf fuer den Fork
Operative Roadmap: Multica-Context-Epic `NIL-327`
Adaptervertrag: [EXCALIDRAW_ADAPTER.md](./EXCALIDRAW_ADAPTER.md)

## Zwei getrennte Upstreams

ExcaliDash hat zwei unabhaengige Aktualisierungskanaele:

1. **ExcaliDash-Anwendungsupstream**: `ZimengXiong/ExcaliDash` als Git-Remote `origin`.
2. **Excalidraw-Editorupstream**: `@excalidraw/excalidraw` als npm-Abhaengigkeit.

Ein Git-Merge und ein Paketupgrade sind zwei verschiedene Arbeiten und duerfen nicht im selben
ungegliederten Change vermischt werden.

## Greenfield- und Kompatibilitaetsregel

Der Fork wird fuer das definierte Teamziel gebaut. Es gibt keine Pflicht, interne APIs,
Konfigurationen oder Datenformen fuer unbekannte fremde Installationen kompatibel zu halten.

- Upstream-Aenderungen werden in die Zielarchitektur uebersetzt, nicht mit dauerhaften Shims
  umgangen.
- Wenn eine bessere Upstream-Loesung die lokale ersetzt, wird die lokale entfernt.
- Daten werden einmalig migriert oder Entwicklungsinstanzen neu aufgebaut; alte Lese- und
  Schreibpfade bleiben nicht dauerhaft bestehen.
- Kompatibilitaetsentscheidungen sind Produktentscheidungen und keine automatische Vorgabe.

## Branch-Modell

- `origin/main`: unveraenderte Referenz auf ExcaliDash-Upstream
- `fork/main`: kanonischer, veroeffentlichter Integrationsstand und Basis aller Package-PR-Branches
- `upstream-sync/YYYY-MM-DD`: kurzlebiger Branch fuer ExcaliDash-Merge
- `upgrade/excalidraw-X.Y.Z`: kurzlebiger Branch fuer Paketupgrade
- `feat/nil-NNN-slug`, `fix/nil-NNN-slug`: isolierte PR-Branches eines Ownership Packages

Viele Agenten arbeiten in getrennten Git-Worktrees. Pro Ownership Package existieren genau ein
kanonischer Owner und ein langlebiger Package-Worktree; serielle PRs erhalten darin jeweils
einen frischen Branch aus aktuellem `fork/main`. Acceptance Slices erhalten weder Agentenlauf
noch Worktree oder Branch. Der PR Overseer besitzt die Merge-Reihenfolge und integriert lokal
in `fork/main`; es existiert kein zweiter dauerhafter Integrationsbranch.

## ExcaliDash-Upstream synchronisieren

1. Remotes fetchen und Commitbereich dokumentieren.
2. `upstream-sync/YYYY-MM-DD` vom aktuellen Integrationsstand erstellen.
3. `origin/main` als echten Merge integrieren; veroeffentlichte Forkhistorie nicht rebasen.
4. Konflikte fachlich loesen, nicht mit pauschaler `ours`-/`theirs`-Strategie.
5. `git range-diff` beziehungsweise Diff vor/nach Merge pruefen.
6. Build, Unit, Security, Contract und E2E ausfuehren.
7. Unabhaengige Review der Konfliktloesungen.
8. Lokale Patches entfernen, die Upstream nun sauber ersetzt.

Empfohlene lokale Git-Einstellungen fuer wiederkehrende Konflikte:

```bash
git config rerere.enabled true
git config merge.conflictstyle zdiff3
git config fetch.prune true
```

Diese Einstellungen werden einmal bewusst eingefuehrt und dokumentiert, nicht ungeprueft in
laufenden Worktrees veraendert.

## Excalidraw-Paket upgraden

1. Zielversion als exakte Version waehlen; keine unbemerkte Minor-/Patch-Bewegung.
2. Upgrade-Branch erstellen.
3. Lockfile aktualisieren.
4. Adapter-Contract-Tests ausfuehren.
5. Compatibility-Diagnostics auf neue oder fehlende Capabilities pruefen.
6. kritische Browserpfade in Chromium, Firefox, WebKit und Mobile ausfuehren.
7. notwendige Anpassungen ausschliesslich in der Integrationsschicht vornehmen, sofern kein
   echter Produktvertrag geaendert wird.
8. Produktverhaltensaenderungen als eigenes Issue behandeln.
9. unabhaengige Adapterreview.

## Upstream-Beitraege

Ein Change ist Upstream-Kandidat, wenn er:

- nicht von ExcaliDash-spezifischen Produktmodellen abhaengt,
- einen allgemeinen Fehler oder fehlenden oeffentlichen Hook behebt,
- isoliert getestet und erklaert werden kann,
- keine internen Teamannahmen offenlegt.

Produktfeatures wie Kommentare, Team Home oder Activity bleiben im Fork. Generische
Synchronisationsfixes, sichere Sanitizer und fehlende oeffentliche Excalidraw-Hooks werden
upstream angeboten.

Wird ein lokaler Change upstream uebernommen, wird sein lokaler Sonderpfad beim naechsten
Sync entfernt. Es bleiben keine doppelten Implementierungen "zur Sicherheit" bestehen.

## Konflikt- und Integrationsprotokoll

Bei einem Konflikt dokumentiert der bearbeitende Agent im Multica-Issue:

- betroffene Dateien
- Upstream-Absicht
- Fork-Absicht
- gewaehlter Zielzustand
- Tests, die genau diese Aufloesung beweisen
- Session-ID und Branch/Worktree

Abhaengige Agenten werden ueber die kommentierte Session-ID kontaktiert, bevor beide Seiten
denselben Vertrag unabhaengig veraendern.

## Verifikation

Ein Upstream-Change ist erst integriert, wenn:

- beide Builds gruen sind
- Unit-, Security- und E2E-Suites gruen sind
- Adapter-Contracts gruen sind
- Fehlerpfade absichtlich ausgeloest wurden
- keine verbotenen Runtime-Imports oder DOM-Seams hinzugekommen sind
- Diff und Konfliktentscheidungen unabhaengig reviewt wurden
- Multica-Issue und relevante Dokumentation aktualisiert sind

## Was GitHub erzwingt und was Konvention bleibt

Gesetzt ueber `ops/repository-rules.sh apply` (Stand 2026-08-23):

| Regel | Wirkung |
|---|---|
| `allow_squash_merge: false` | Squash ueber die Oberflaeche schreibt den Commit dem zusammenfuehrenden Konto zu und zerstoert die Nilo-Autorschaft. Den lokalen Mergeweg beruehrt die Einstellung nicht. |
| `non_fast_forward` auf `main` | Kein Force-Push. Ein umgeschriebener `main` wuerde jeden Worktree und jede offene PR-Basis entwurzeln. |
| `deletion` auf `main` | `main` laesst sich nicht loeschen. |
| `required_status_checks` auf `main` | Alle acht `Tests`-Jobs muessen gruen sein. |

### Warum Pflichtchecks den lokalen Merge NICHT blockieren

Das ist nicht offensichtlich, und eine fruehere Fassung dieses Abschnitts hat genau hier das
Gegenteil behauptet. Beide Haelften sind am 23.08.2026 ausgeloest worden, nicht abgeleitet:

- Ein Push eines **neuen Commits ohne zugehoerigen PR** wird abgelehnt. Gemessen an einem
  Wegwerf-Branch: `GH013 ... Required status check "Backend Tests" is expected`. Ohne die Regel
  ging derselbe Push durch — die Ablehnung kam nachweislich von ihr.
- Der **Merge-Commit eines offenen PR, dessen Pflichtchecks gruen sind**, wird dagegen
  angenommen, obwohl dieser Merge-Commit selbst keine Check-Runs traegt. Gemessen beim Push von
  `85c3919` (Merge von PR #46) auf `main` mit aktiver Regel. Die Rule-Suite weist
  `required_status_checks` als **ausgewertet mit `result: pass`** aus, nicht als umgangen:

  ```bash
  gh api repos/davifernan/excalidash/rulesets/rule-suites/3786720518 \
    --jq '[.rule_evaluations[] | {rule_type, result}]'
  ```

Der urspruengliche Fehlschluss war, aus der ersten Messung die zweite abzuleiten: ein neuer SHA
ohne Checks wird abgelehnt, **also** muesse ein Merge-Commit abgelehnt werden. GitHub bewertet
aber nicht nur den gepushten SHA isoliert, sondern erkennt den zugehoerigen PR. Die Lehre ist
allgemeiner als dieser Fall: eine Messung an einem Ersatzobjekt belegt das Ersatzobjekt.

**Fallstrick bei Checknamen:** `required_status_checks` matcht **Job**-Namen (`Backend Tests`,
`Dead Code`, ...), nicht Workflow-Namen. Einen Check namens `Tests` gibt es nicht — das ist der
Workflow. Ein Pflichtcheck, den kein Workflow erzeugt, blockiert dauerhaft jeden Push; aus
demselben Grund darf der abgeschaltete `PR Overseer Events` dort nie auftauchen. `Build and push`
fehlt bewusst: er laeuft per `workflow_run` erst **nach** `Tests` auf `main`, ihn zu verlangen
waere ein Deadlock.

### Bewusst nicht gesetzt

- **`pull_request` („Require a pull request before merging")** blockiert genau den lokalen
  Nilo-Merge, der das Liefermodell ist. Siehe NIL-391 (geparkt).

Konvention bleibt damit: dass ein PR geoeffnet wird, dass Hans ihn reviewt, und die
Merge-Reihenfolge. **Nicht** mehr Konvention ist, dass die Checks gruen sind — das erzwingt
GitHub jetzt.

Drift gegen diese Datei findet `ops/repository-rules.sh verify` (Exitcode 1 bei Abweichung).

Rueckgaengig machen: `ops/repository-rules.sh revert`.

## Git-Identitaet

Vor jedem Commit oder Merge:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Beide muessen `Nilo <127136134+davifernan@users.noreply.github.com>` ergeben. Die
server-globale Git-Konfiguration ist verbindlich; keine repository-lokalen Identitaets-Overrides.
Jede Commit-Nachricht endet mit
`Generated by Nilo`. Nach jedem Commit oder Merge:

```bash
git show -s --format='author=%an <%ae>%ncommitter=%cn <%ce>' HEAD
```

GitHub-Squash-Merges, die eine andere Urheberschaft erzeugen, werden nicht verwendet.
