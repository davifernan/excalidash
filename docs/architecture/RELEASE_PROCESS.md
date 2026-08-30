# Release Process

Status: verbindlicher Ablauf ab NIL-507 (24.08.2026)
Verwandt: [UPSTREAM_MAINTENANCE.md](./UPSTREAM_MAINTENANCE.md) ("Tag-Namensraum"),
[DELIVERY_V2.md](./DELIVERY_V2.md) ("PR contract")

## Warum das hier existiert

Bis NIL-507 gab es keinen Release-Workflow -- nur `publish-images.yml`, das bei jedem gruenen
Push auf `main` `latest` und `sha-<kurz>` aktualisiert. Das ist fuer Deployment richtig
(`docker-compose.prod.yml` zieht `latest`), aber es hinterlaesst nirgendwo eine Spur, die ein
Nutzer lesen koennte: keinen Tag, kein GitHub-Release, keine Notes. `VERSION` stand bei `0.6.0`,
waehrend seither fuenf Pakete in `main` lagen -- unversioniert und ungeschrieben. Dieses Dokument
beschreibt den Ablauf, der das schliesst.

## Die drei Dinge, die nicht auseinanderlaufen duerfen

`VERSION`, der Release-Tag und die Release-Notes muessen dieselbe Wahrheit erzaehlen. Jedes hat
eine eigene Pruefung, am Ort, an dem der jeweilige Fakt ueberhaupt bekannt ist:

| Fakt | Wo geprueft | Warum dort |
|---|---|---|
| `VERSION` kollidiert nicht mit einem fremden, nicht-eigenen Tag gleichen Namens | `scripts/release-tag-guard.cjs`, jeder PR | Eine PR kennt ihren eigenen kuenftigen Tag noch nicht -- aber sie kann schon wissen, ob die Versionsnummer, die sie gerade setzt, anderswo bereits (falsch) vergeben ist |
| `VERSION` == die Zahl im Tag | `.github/workflows/release.yml`, Schritt "Verify VERSION and tag actually agree" | Erst beim Taggen existiert der Tag ueberhaupt |
| Die Notes decken exakt den Bereich `vorheriger-Tag..dieser-Tag` ab | `scripts/release-notes-collect.cjs` | Baut den Bereich aus den beiden Tags selbst -- kann strukturell nicht abweichen |

## Wie ein Release entsteht

1. **Eine normale PR bumpt `VERSION`** (und synct `backend/package.json` /
   `frontend/package.json` per `node scripts/version-manager.js set X.Y.Z`). Kein
   Sonderprozess -- dieselbe PR-Pipeline, derselbe Sechs-Zeilen-Vertrag wie jede andere
   (siehe [DELIVERY_V2.md](./DELIVERY_V2.md)).
2. **Nach dem Merge: ein Tag, von Hand**, blankes Semver `vX.Y.Z`:

   ```bash
   git tag -a v0.8.0 <merge-sha> -m "..."
   git push own refs/tags/v0.8.0   # NIE --tags, siehe UPSTREAM_MAINTENANCE.md
   ```

   Bis 25.08.2026 trugen diese Tags das Suffix `-nilo.N`, um Upstreams Namensraum
   auszuweichen. Das ist entfallen: `scripts/release-tag-guard.cjs` **prueft** die Kollision
   jetzt bei jedem PR, statt dass eine Namenskonvention ihr ausweicht. Faellt dieser Waechter,
   ist die Nummer belegt -- dann **VERSION anheben**, nicht ein Suffix erfinden. Siehe
   [UPSTREAM_MAINTENANCE.md](./UPSTREAM_MAINTENANCE.md), Abschnitt "Tag-Namensraum".
3. **Der Tag-Push loest `.github/workflows/release.yml` aus.** Der Workflow:
   - prueft, dass `VERSION` am getaggten Commit exakt der Zahl im Tag entspricht;
   - prueft, dass alle Check-Runs an genau diesem Commit bereits gruen sind (er fuehrt
     KEINE Tests selbst erneut aus -- siehe "Warum keine eigene Testausfuehrung" unten);
   - sammelt Release-Notes aus jeder PR im Bereich `vorheriger-Tag..dieser-Tag`
     (`scripts/release-notes-collect.cjs`, Details unten);
   - baut und pusht versionierte Images (`:X.Y.Z` und `:vX.Y.Z`) nach GHCR;
   - legt ein **Draft**-GitHub-Release mit den gesammelten Notes an oder aktualisiert ein
     bestehendes.
4. **Ein Mensch poliert den Draft** auf der GitHub-Releases-Seite und veroeffentlicht ihn.
5. **Der Mensch traegt den veroeffentlichten Text von Hand in `CHANGELOG.md` ein**, als neuer
   Abschnitt oben, in einer normalen PR. Der Workflow selbst schreibt niemals nach `main` --
   ein tag-getriggerter CI-Lauf mit Schreibzugriff auf den geschuetzten Default-Branch waere
   genau der ungeprueften Schreibpfad, den dieses Repo bewusst nicht hat.

   Jede sichtbare Aussage dieses neuen Abschnitts bekommt unmittelbar davor eine unsichtbare
   `<!-- release-source: #NNN -->`-Marke. Der PR bleibt fuer Leser frei von internen Nummern;
   `release-tag-guard.cjs` prueft die Marke aber gegen GitHub und den geprueften Git-Head:
   die PR muss gemergt sein, ihr Merge-Commit Vorfahr sein und ihr Vertrag eine nutzbare
   `User-Facing:`-Zeile enthalten. So kann ein Changelog keine offene Funktion behaupten.

## Warum keine eigene Testausfuehrung im Release-Workflow

Ein frueher Entwurf liess `release.yml` die volle Suite erneut laufen, bevor es etwas
veroeffentlicht. Verworfen, aus zwei Gruenden:

- **Es ist redundant.** Branch Protection auf `main` verlangt bereits, dass alle als Pflicht
  markierten `Tests`-Jobs gruen sind, bevor ein Merge-Commit ueberhaupt ankommt
  (UPSTREAM_MAINTENANCE.md, "Was GitHub erzwingt"). Ein getaggter Commit auf `main` hat diese
  Pruefung also strukturell schon bestanden.
- **Es exponiert das Release unnoetig gegen Flakiness.** Gemessen 24.08.2026: der Spec
  `dashboard-workflows.spec.ts` ("should duplicate multiple drawings and move them to trash
  via bulk toolbar") ist auf `main` und auf einem fremden Zweig einmal rot gefallen und bei
  einem sofortigen Re-Run desselben Commits gruen gewesen -- ein flackernder, nicht
  deterministischer Test. Ein Release-Workflow, der die Suite selbst erneut ausfuehrt, wuerde
  bei genau so einem Fall ein an sich gutes Release verweigern, und "ein Release, das an einem
  flackernden Test scheitert" ist der beschriebene halbe Zustand in einer anderen Form: die
  Images sind fertig, das Release fehlt, ohne echten Grund.

  Stattdessen liest `release.yml` die bereits vorhandenen Check-Runs des getaggten Commits
  ueber die GitHub-API. Das ist keine Aufweichung der Pruefung -- es ist dieselbe Evidenz, nur
  ein zweites Mal gelesen statt ein zweites Mal erzeugt. Ein Commit, der es aus irgendeinem
  Grund ohne Check-Runs auf `main` geschafft hat (Ruleset-Luecke, manuell gepushter Commit),
  wird trotzdem abgelehnt: `TOTAL=0` ist im Workflow ein harter Fehler, kein stiller Pass.

  Diese Lese-Logik lebt in `scripts/release-check-runs.sh`, nicht inline im Workflow: Hans-
  Friedrich fand auf PR #79, dass `gh api --paginate --jq FILTER` den Filter pro Seite
  ausfuehrt statt auf dem zusammengefuehrten Ergebnis -- ab mehr als einer Seite (heute >30
  Check-Runs) waeren `TOTAL`/`INCOMPLETE`/`FAILED_COUNT` mehrzeilige Strings statt Zahlen
  gewesen, und ein laengst gruenes Release haette der Workflow faelschlich verweigern koennen.
  Behoben mit `--paginate --slurp` plus einem einzigen zusammenfuehrenden `jq`-Aufruf. Die
  Gegenprobe (`scripts/release-check-runs.test.sh`) laeuft bewusst gegen die echte GitHub-API
  und einen echten, laengst gemergten Commit mit `per_page=2` erzwungen, statt gegen eine
  Attrappe -- ein Test, der nur den Ein-Seiten-Fall prueft, waere gruen geblieben und haette
  nichts bewiesen, weil der Fehler erst jenseits einer Seite ueberhaupt auftritt.

  Die Flakiness selbst ist damit nicht geloest, nur nicht dupliziert. Sie ist als eigener Fund
  gemeldet: siehe die zugehoerige Multica-Karte fuer den aktuellen Stand.

## Wie Release-Notes entstehen: `User-Facing:` statt Commit-Archaeologie

Davis Vorgabe (24.08.2026), zwei harte Punkte:

- **Keine Ticketnummern** in Notes, die ein Nutzer liest -- niemand ausserhalb von Multica hat
  ein Konto dort, und eine nackte Nummer wie `NIL-292` bedeutet nichts.
- **Der Text muss gut sein, nicht bloss vorhanden.** Ein Autopilot, der Notes aus
  Commit-Titeln generiert, produziert genau das, was niemand liest --
  `fix(dashboard): add drawing favorites, backend`.

Der einzige Zeitpunkt, an dem zuverlaessig bekannt ist, was ein Nutzer an einer Aenderung
merkt, ist beim Liefern selbst -- der Implementer weiss es dort, niemand danach kann es aus
dem Diff zuverlaessig rekonstruieren. Deshalb ist `User-Facing:` seit NIL-507 die sechste
Pflichtzeile im PR-Vertrag (siehe [DELIVERY_V2.md](./DELIVERY_V2.md)):

```text
User-Facing: Boards can now be starred and pinned to the top of the dashboard.
```

oder `User-Facing: none` fuer ein Paket, das nur Waechter, Tests oder interne Verkabelung
aendert. `scripts/delivery-v2.cjs`s `parsePrDeliveryContract` erzwingt genau eine Zeile und
lehnt jede Zeile ab, die `NIL-\d+` oder `#\d+` enthaelt -- die Regel ist maschinell erzwungen,
nicht Konvention.

`scripts/release-notes-collect.cjs` **erfindet nichts** -- das ist die Antwort auf die Frage,
an der jeder Mechanismus hier gemessen wird ("kann er einen Eintrag erfinden, der so nie
geliefert wurde?"): es kopiert die `User-Facing:`-Zeile jeder gemergten PR im Bereich
woertlich und sortiert sie ueber deren eigene `Change-Kind:`-Zeile (`added` -> Added, `fixed`
-> Fixed, `changed` -> Changed) in eine von drei Gruppen. Bis NIL-577 zaehlte diese Einordnung
die Commit-Praefixe der PR (`feat` -> Added, `fix` -> Fixed, sonst Changed) -- das misst aber
die Entstehungsgeschichte eines Zweigs, nicht die Absicht: PR #138 (der Markdown-Editor) trug
neben seinem Feature-Commit mehrere `fix:`-Nachbesserungen und landete dadurch als "Fixed" im
`v0.9.0`-Entwurf. Diese Zaehlung lebt als `categorize()` nur noch als Ausweichpfad fuer PRs
weiter, die vor NIL-577 gemergt wurden und keine `Change-Kind:`-Zeile tragen; jede PR seither
erklaert ihre Gruppe selbst. Jede PR ohne brauchbare `User-Facing:`-Zeile (fehlend, mehrdeutig,
oder `none`) faellt mit einer Warnung aus -- niemals mit einer geratenen Ersatzformulierung.
Diese Warnungen landen sichtbar in der Job-Zusammenfassung, nicht im Log-Rauschen: ein
stillschweigend uebersprungener Eintrag ist ein stiller Datenverlust, kein akzeptabler
Default.

Der Bereich wird nicht ueber `GET repos/{repo}/commits/{sha}/pulls` auf PRs abgebildet. Diese
Assoziationssuche war bei Sammelmerges nachweislich mehrdeutig: zwei Abfragen desselben
`v0.7.0-nilo.4..v0.8.0`-Bereichs ordneten #134 und #135 verschieden zu, und ein Draft verlor
dadurch die sichtbarste Aenderung. Stattdessen liest der Sammler die kanonische Richtung aus
den PR-Datensaetzen: jede gemergte PR traegt ihre `merge_commit_sha`. Mehrere PRs duerfen
dieselbe Sammel-SHA tragen (#132 und #134 tragen beide `99a0369`); innerhalb einer SHA ordnet
die PR-Nummer das Ergebnis reproduzierbar. Weil damit jede gemergte PR im Bereich vor der
`User-Facing:`-Pruefung bekannt ist, erzeugt jede fehlende, mehrdeutige oder als `none`
deklarierte Zeile eine sichtbare `SKIP`-Warnung statt schon bei der Zuordnung zu verschwinden.
Die paginierte PR-Suche endet, sobald die nach `updated_at` absteigend sortierten Seiten hinter
dem Commit des vorherigen Release liegen. Das ist keine Zeit-Heuristik fuer die Zugehoerigkeit:
`updated_at` kann nicht vor `merged_at` liegen, und die eigentliche Aufnahme entscheidet
weiterhin ausschliesslich die `merge_commit_sha` im lokalen Git-Bereich. Ein alter, spaeter
editierter PR wird hoechstens zusaetzlich gelesen und danach wieder herausgefiltert.

### Die fuenf Pakete, die vor dieser Zeile gemergt wurden

`User-Facing:` existiert seit NIL-507. Die fuenf Pakete, die zwischen dem letzten
0.6.0-Stand und diesem Release gemergt wurden, hatten die Zeile nicht -- ihre Notes in
`CHANGELOG.md`s `v0.7.0-nilo.1`-Abschnitt wurden von Hand aus den ausfuehrlichen
Merge-Commit-Beschreibungen dieser Runde gezogen, einmalig. Das ist Nacharbeit, keine
Dauerloesung: jedes kuenftige Release bekommt seine Notes automatisch aus der Zeile, die
laengst existiert, wenn das Release passiert.

## `CHANGELOG.md` statt `RELEASE.md`

`RELEASE.md` wurde bei jedem Release komplett ueberschrieben -- die Notes des vorherigen
Release waren in dem Moment weg, in dem die naechsten geschrieben wurden. Genau das ist
Davis Befund ("verpasste Chance"): es gab nie einen Ort, an dem ein Nutzer sehen konnte, was
sich ueber die Zeit veraendert hat. `CHANGELOG.md` ist eine fortlaufende, anhaengende Datei
nach dem etablierten Keep-a-Changelog-Muster (neueste Version oben, Gruppen
Added/Fixed/Changed) -- eine Datei statt einer pro Release, weil das Vergleichen zweier
Versionen und das Durchsuchen der ganzen Historie sonst ueber mehrere Dateien verteilt waere,
fuer keinen erkennbaren Gewinn.

`RELEASE.md`, `scripts/reset-release-notes.cjs`, `scripts/release-notes-template.md` sowie die
alten `make release`/`make pre-release`/`make dev-release`-Ziele und
`scripts/publish-docker*.sh` sind mit diesem Package entfernt worden: sie stammten unveraendert
aus dem Upstream-Fork, operierten auf `origin` (dem ExcaliDash-Upstream, nicht unserem `own`)
und auf dem Docker-Hub-Konto `zimengxiong` -- keines von beidem ist etwas, worauf dieser Fork
schreiben kann oder sollte. Ein `make release` haette versucht, direkt nach `origin/main` zu
pushen und einen blanken `vX.Y.Z`-Tag anzulegen: genau die Kollision, die
`scripts/release-tag-guard.cjs` jetzt verhindert. Tote, zudem gefaehrliche Tooling-Pfade
bleiben nicht "fuer den Fall der Faelle" stehen (Greenfield-Regel, `AGENTS.md`).
