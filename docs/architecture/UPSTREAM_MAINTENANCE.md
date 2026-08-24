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

- `origin/main`: unveraenderte Referenz auf ExcaliDash-Upstream -- steht seit dem Fork still.
  Die tatsaechliche Upstream-Entwicklung laeuft auf `origin/alpha` (Stand 23.08.: 9 Commits,
  244 Dateien seit der gemeinsamen Basis `294097c`; Bewertung und Kostenuebersicht in NIL-378,
  Rehearsal-Befund in [UPSTREAM_SYNC_LOG.md](./UPSTREAM_SYNC_LOG.md)). "Upstream synchronisieren"
  heisst hier: mit `alpha` abgleichen, nicht mit `main`.
- `fork/main`: kanonischer, veroeffentlichter Integrationsstand und Basis aller Package-PR-Branches
- `upstream-sync/YYYY-MM-DD`: kurzlebiger Branch fuer ExcaliDash-Merge
- `upgrade/excalidraw-X.Y.Z`: kurzlebiger Branch fuer Paketupgrade
- `feat/nil-NNN-slug`, `fix/nil-NNN-slug`: isolierte PR-Branches eines Ownership Packages

Viele Agenten arbeiten in getrennten Git-Worktrees. Pro Ownership Package existieren genau ein
kanonischer Owner und ein langlebiger Package-Worktree; serielle PRs erhalten darin jeweils
einen frischen Branch aus aktuellem `fork/main`. Acceptance Slices erhalten weder Agentenlauf
noch Worktree oder Branch. Der PR Overseer besitzt die Merge-Reihenfolge und integriert lokal
in `fork/main`; es existiert kein zweiter dauerhafter Integrationsbranch.

### Worauf beim Abgleich mit `alpha` zu achten ist

Volle Bewertung und Kostenuebersicht in NIL-378; hier die drei Punkte, die einen unvorsichtigen
Merge oder eine unvorsichtige Uebernahme sofort brechen wuerden:

- **`origin/alpha` loescht die Root-`README.md` komplett** (`git show origin/alpha:README.md`
  schlaegt fehl -- die Datei existiert dort nicht). Dort steht unsere Betriebsdokumentation; ein
  ungeprueft uebernommener Merge wuerde sie entfernen.
- **`origin/alpha` entfernt u. a. `backend/src/securityTest.ts`**, das unser Fork aktiv nutzt
  (`backend/knip.json` fuehrt es als Entry-Point, `.github/workflows/test.yml` ruft es direkt
  per `npx ts-node src/securityTest.ts` auf). Ein Merge, der die upstream-Loeschung uebernimmt,
  bricht die CI.
- **Lizenzwechsel:** `alpha` enthaelt den Commit `3e03110` ("Change license from AGPL to LGPL").
  Als Fakt festgehalten, nicht bewertet -- eine Entscheidung darueber, ob der Fork mitzieht, ist
  Davis, keine automatische Sync-Folge.
- **Release-Notiz-Korrektur:** die dort beworbene 30-Tage-Gueltigkeit von Agenten-Tokens
  existiert im `alpha`-Code nicht (kein `expiresAt` im Schema, keine Pruefung bei der
  Authentifizierung) -- vor einer Uebernahme nachpruefen, nicht der Ankuendigung glauben.

Upstreams kritischster ungeloester Punkt: der Live-Pfad hat denselben Fehler wie unserer (vor
dem Senden gebucht, kein Ack, keine Aufteilung -- `origin/alpha:frontend/src/pages/editor/
useEditorSceneApi.ts:55-70`). NIL-315 bleibt deshalb noetig, unabhaengig vom Sync-Stand.

## `nilo/live` vs. `main`

`nilo/live` ist **kein** dritter Aktualisierungskanal und **nicht** die Grundlage der laufenden
Produktion. Stand 23.08.2026:

- Rein lokaler Branch, nie auf `own` gepusht (`git ls-remote own nilo/live` liefert nichts).
- Letzter Commit `536f659` vom 22.08. 13:48 Uhr -- **211 Commits hinter `fork/main`**, 0 Commits
  voraus. Er ist kein Vorgriff auf `main`, sondern ein alter Stand, der stehen geblieben ist.
- Der Worktree `excalidash-live` führt darauf `npm run dev`-Prozesse aus (Frontend via Vite auf
  Port 6767, Backend via `nodemon` auf einem separat gewählten Port). Das ist exakt der in
  `AGENTS.md` dokumentierte lokale Dev-Weg (`make dev`, Standardport 6767) -- nur manuell
  gestartet und seit Tagen nicht neu geladen.
- **Diese Prozesse bedienen draw.nilo.live nicht.** Die aktive Nginx-Config
  (`/etc/nginx/sites-enabled/draw.nilo.live`) leitet ausschließlich auf `127.0.0.1:6770` --
  den Frontend-Container aus `docker-compose.yml`/`docker-compose.prod.yml` in
  `/home/claude/excalidash` (GHCR-Image, aktuell `sha-21545d7`, siehe `docker ps`). Die
  Referenzdatei `nginx-draw.nilo.live` im selben Verzeichnis nennt noch Port 6767 -- das ist
  eine dokumentierte Drift zwischen eingecheckter Referenz und tatsächlich deployter Config,
  keine Anleitung zum aktuellen Zustand.

**Konsequenz:** `nilo/live` ist ein verwaister, lokal weiterlaufender Vorschau-/Dev-Stand aus der
Zeit vor dem heutigen dockerisierten Produktions-Deploy (Backup-Zeitstempel
`excalidash-20260812-095535-vor-nilo-live` datiert seine Entstehung grob auf den 12.08.). Er ist
weder Referenz noch Staging für irgendetwas, das aktuell bedient wird.

**Wie man ihn aktualisiert, ohne die Fork-Historie zu verbiegen -- falls er weiter gebraucht
wird:** ein echter Fast-Forward oder Merge von `fork/main` in `nilo/live`, kein Rebase (der
Branch ist lokal, ein Rebase wäre zwar risikofrei fürs Remote, aber unnötig, wenn ein einfacher
Fast-Forward ausreicht, weil `nilo/live` keine eigenen unveröffentlichten Commits trägt). Die
laufenden `npm run dev`-Prozesse müssten danach neu gestartet werden, um den neuen Stand
tatsächlich zu servieren.

**Empfehlung statt Aktualisierung:** Da nichts ihn erreicht und die Maschine schon einmal an
RAM-Erschöpfung gestorben ist, ist Stilllegen (Dev-Prozesse stoppen, Worktree als reine
Git-Referenz behalten oder entfernen) wahrscheinlicher richtig als Nachziehen. Das ist eine
Betriebsentscheidung, keine Aufräum-Entscheidung -- sie gehört Davi oder wer auch immer
`nilo/live` ursprünglich für seinen jetzigen Zweck gestartet hat, nicht diesem Package.

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

## Tag-Namensraum: Kollision mit Upstream

Gemessen 24.08.2026 (NIL-507): `VERSION` sagte `0.6.0`, und ein Tag `v0.6.0` existierte
bereits in diesem Arbeitsbaum -- aber es war ExcaliDash-Upstreams eigener Tag (`origin`),
und er zeigte auf einen Commit, der kein Vorfahr unseres `main` ist. Unser eigener
0.6.0-Release-Punkt (`f9108aa`, PR #68) war nie getaggt worden. Wer in einem Checkout mit
beiden Remotes -- genau diesem Arbeitsbaum -- `git describe` glaubt, bekommt Upstreams
Antwort fuer unseren Commit.

**Regel, dauerhaft:** jeder eigene Release-Tag dieses Forks traegt das Suffix `-nilo.N`,
nach dem Muster, das `v0.5.1-nilo.1`/`v0.5.1-nilo.2` schon vor dieser Regel etabliert
hatten. `N` startet bei `1` je nominaler Version und zaehlt bei einem weiteren Tag auf
demselben `X.Y.Z` hoch. Ein **blanker** `vX.Y.Z`-Tag ohne Suffix wird von diesem Fork nie
neu angelegt -- dieser Namensraum gehoert Upstream, auch wenn eine bestimmte Nummer bei uns
gerade frei aussieht, weil sie es lokal (noch) ist. `v0.6.0-nilo.1` (dieser Nachtrag) und
`v0.7.0-nilo.1` (der naechste eigene Release ab diesem Package) folgen dem Muster.

**Nie `git push own --tags`.** Der Befehl pusht alle lokalen Tag-Refs, einschliesslich
jedem Upstream-Tag, den man je von `origin` gefetcht hat -- er wuerde genau die Kollision,
die diese Regel vermeiden soll, aktiv in unser eigenes Fork-Repo hineinschieben. Immer den
exakten Tag-Ref pushen: `git push own refs/tags/vX.Y.Z-nilo.N`.

**CI-Waechter:** `scripts/release-tag-guard.cjs` (Job "Delivery Contract Tests", Schritt
"Check the release tag guard") laeuft bei jedem PR und lehnt ab, wenn ein blanker
`v<VERSION>`-Tag existiert, der kein Vorfahr des geprueften Commits ist -- der Fall, der
`v0.6.0` real getroffen hat. Er sieht in CI nur die Tags des eigenen `own`-Remotes (der
Runner klont nur dieses Repo, nie `origin`); lokal, wo beide Remotes konfiguriert sind, ist
er strenger, weil er dort auch Upstreams Tags sieht.

Wie ein Release-Tag ueberhaupt entsteht und wie der Release-Workflow VERSION/Tag-Kohaerenz
im Moment der Wahrheit prueft: [RELEASE_PROCESS.md](./RELEASE_PROCESS.md).

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

### Vorbereitete Kandidaten (NIL-301/302/303), Stand 24.08.2026

Geprüft mit einem Trocken-Cherry-Pick jedes Kandidaten-Commits auf `origin/main` (die
ExcaliDash-Upstream-Spitze), Ergebnis danach verworfen. Der Cherry-Pick-Befund unten bleibt
gültig; der Push-/PR-Status hat sich seit der ursprünglichen Prüfung geändert:

- **NIL-301 und NIL-302 sind inzwischen von Davi selbst als PR eröffnet**: PR #247 ("Stop
  version history from eating the disk", seit 2026-08-18) und PR #248 ("Actually deliver
  password reset emails", seit 2026-08-18). Die Freigabe, an die dieser Schritt gebunden war,
  liegt für diese beiden also vor.
- **NIL-303 hat weiterhin keine offene PR** -- konsistent mit der Bewertung "nicht bereit"
  unten (Umfang muss erst gegen den aktuellen `origin/main`-Stand neu gebaut werden).

| Kandidat | Branch (lokal, ungepusht) | Cherry-Pick auf `origin/main` | Bewertung |
|---|---|---|---|
| **NIL-301** Snapshot-Kompression | `feat/snapshot-compression` (`5d672b9`, `304e518`) | sauber, keine Konflikte | bereit. Generischer Perf-Fix an der Versions-Historie (Brotli-Kompression, Rückgabe freier Seiten), hängt an keinem ExcaliDash-Produktmodell |
| **NIL-302** Resend-Mailversand | `feat/resend-email` (`8baaf15`, `23feee1`) | Auto-Merge in `backend/.env.example` und `backend/src/config.ts`, keine echten Konflikte | bereit nach kurzer manueller Durchsicht der zwei Auto-Merges. SMTP-alongside-Resend für Passwort-Reset-Mails, generisch nutzbar für jede Selbst-Hosting-Instanz |
| **NIL-303** Sticky-Notes-Toolbar-Button | `feat/sticky-toolbar`, konkret `6e75494` | **8 Konflikte, davon 5× `modify/delete`** auf `frontend/src/sticky/*` -- diese Dateien existieren auf `origin/main` in dieser Form nicht | **nicht bereit.** Der Fork hat die Sticky-Notes-Implementierung strukturell vom Upstream-Stand entkoppelt (eigene `frontend/src/sticky/`-Struktur). Der Commit ist kein kleiner generischer Patch mehr, sondern setzt die Fork-eigene Architektur voraus. Um das upstream-tauglich zu machen, müsste die Idee ("Werkzeug im Toolbar portalen, Taste N") gegen den tatsächlichen aktuellen `origin/main`-Stand der Sticky-Notes neu gebaut werden, nicht per Cherry-Pick übernommen |

NIL-303 braucht vor jedem PR-Versuch eine Neubewertung des Umfangs -- das ist kein
Vorbereitungsschritt mehr, sondern eigene Implementierungsarbeit gegen einen fremden Codestand.

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
