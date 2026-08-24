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
2. **Nach dem Merge: ein Tag, von Hand**, nach dem Muster `vX.Y.Z-nilo.N`:

   ```bash
   git tag -a v0.7.0-nilo.1 <merge-sha> -m "..."
   git push own refs/tags/v0.7.0-nilo.1   # NIE --tags, siehe UPSTREAM_MAINTENANCE.md
   ```

   Nie eine blanke `vX.Y.Z`-Tag -- dieser Namensraum gehoert Upstream, siehe
   [UPSTREAM_MAINTENANCE.md](./UPSTREAM_MAINTENANCE.md), Abschnitt "Tag-Namensraum".
3. **Der Tag-Push loest `.github/workflows/release.yml` aus.** Der Workflow:
   - prueft, dass `VERSION` am getaggten Commit exakt der Zahl im Tag entspricht;
   - prueft, dass alle Check-Runs an genau diesem Commit bereits gruen sind (er fuehrt
     KEINE Tests selbst erneut aus -- siehe "Warum keine eigene Testausfuehrung" unten);
   - sammelt Release-Notes aus jeder PR im Bereich `vorheriger-Tag..dieser-Tag`
     (`scripts/release-notes-collect.cjs`, Details unten);
   - baut und pusht versionierte Images (`:X.Y.Z` und `:vX.Y.Z-nilo.N`) nach GHCR;
   - legt ein **Draft**-GitHub-Release mit den gesammelten Notes an oder aktualisiert ein
     bestehendes.
4. **Ein Mensch poliert den Draft** auf der GitHub-Releases-Seite und veroeffentlicht ihn.
5. **Der Mensch traegt den veroeffentlichten Text von Hand in `CHANGELOG.md` ein**, als neuer
   Abschnitt oben, in einer normalen PR. Der Workflow selbst schreibt niemals nach `main` --
   ein tag-getriggerter CI-Lauf mit Schreibzugriff auf den geschuetzten Default-Branch waere
   genau der ungeprueften Schreibpfad, den dieses Repo bewusst nicht hat.

## Warum keine eigene Testausfuehrung im Release-Workflow

Ein frueher Entwurf liess `release.yml` die volle Suite erneut laufen, bevor es etwas
veroeffentlicht. Verworfen, aus zwei Gruenden:

- **Es ist redundant.** Branch Protection auf `main` verlangt bereits, dass alle acht
  `Tests`-Jobs gruen sind, bevor ein Merge-Commit ueberhaupt ankommt
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
woertlich, sortiert sie anhand der Commit-Praefixe der PR (`feat` -> Added, `fix` -> Fixed,
sonst Changed) in eine von drei Gruppen, und laesst jede PR ohne brauchbare Zeile (fehlend,
mehrdeutig, oder `none`) mit einer Warnung aus -- niemals mit einer geratenen Ersatzformulierung.
Diese Warnungen landen sichtbar in der Job-Zusammenfassung, nicht im Log-Rauschen: ein
stillschweigend uebersprungener Eintrag ist ein stiller Datenverlust, kein akzeptabler
Default.

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
