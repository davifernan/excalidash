# NIL-609: Rueckmeldung aus 0.9 gegen 0.12.0

Geprueft wurde `main` bei `ae7f006438bedaf51cba54a4f692082edcaec430` in Chromium bei
1280 x 720. Die Rohmesswerte stehen in
[`docs/evidence/nil-609/metrics.json`](../evidence/nil-609/metrics.json).

| Nr. | Ergebnis                 | Browserbefund                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **behoben**              | Das Bibliothek- und das Share-Icon liegen beide bei `y=30`, sind jeweils 16 px hoch und haben damit `0 px` vertikalen Mittelpunktversatz. Behoben durch NIL-579 / [PR #147](https://github.com/davifernan/excalidash/pull/147), der den vorher gemessenen 4-px-Versatz auf 0 px korrigierte. [Screenshot](../evidence/nil-609/01-library-share-alignment.png)                                                                                                                                                                                                                                                                                                                                           |
| 2   | **behoben**              | Das rechte Rotate-Ccw-Icon ist jetzt `Restart timer`; nach dem Ziehen blieb der Timer beim Klick unveraendert bei `(838,464)`, waehrend die Zeit von `00:58` auf `01:00` sprang. Behoben durch NIL-604 / [PR #187](https://github.com/davifernan/excalidash/pull/187), integriert in `main` mit `ae7f006`. Das exakte Verhalten deckt auch der Browsertest „the restart button restarts the timer without changing measured position“ ab. [Screenshot](../evidence/nil-609/02-timer-reset-control.png)                                                                                                                                                                                                  |
| 3   | **trifft weiterhin zu**  | Im selben statischen Zustand sind die Hauptleiste weiss, das aktive Auswahlwerkzeug blau und Hamburger, Timer sowie die obere rechte Leiste grau hinterlegt. Die unterschiedliche Flaechenbehandlung ist damit weiterhin sichtbar, unabhaengig davon, dass aktive Auswahl und zurueckgenommene Sekundaer-Chrome unterschiedliche Zustaende ausdruecken sollen. [Screenshot](../evidence/nil-609/03-button-colors-state-hierarchy.png)                                                                                                                                                                                                                                                                   |
| 4   | **nicht reproduzierbar** | Statt eines fehlenden Hex-Felds zeigt das aktuelle Menue fuenf Presets und als sechstes Feld den Custom-Color-Ausloeser. Ein Klick darauf oeffnet rechts einen eigenen Popover mit `Hex code` und dem aktuellen Wert `ffffff`; das Eingabefeld muss daher keinen Platz am Ende der Preset-Zeile teilen. Die Preset-Felder sind 21,59 px breit und liegen 10,25 px auseinander. [Screenshot](../evidence/nil-609/04-canvas-background-custom-hex.png)                                                                                                                                                                                                                                                    |
| 5   | **trifft weiterhin zu**  | Die sichtbaren Icons haben weiterhin unterschiedliche Strichbilder. Die Ursache sind tatsaechlich zwei Icon-Quellen: ExcaliDash rendert seine Chrome-Ergaenzungen aus `lucide-react` (zum Beispiel `Share2` und `RotateCcw`), waehrend Toolbar, Library und die Excalidraw-eigenen Menuepunkte aus `@excalidraw/excalidraw` und dessen eigener Icon-Sammlung kommen. Im Browser traegt Share die Klasse `lucide lucide-share2 lucide-share-2`; das Library-SVG hat keine Lucide-Klasse. Beide Pakete sind direkte Frontend-Abhaengigkeiten. Damit ist die Paketgrenze der primaere Befund, nicht eine einzelne falsch gestylte Fundstelle. [Screenshot](../evidence/nil-609/05-icon-weight-sources.png) |
| 6   | **trifft weiterhin zu**  | Die Sprachauswahl ist im weissen Menue weiterhin als graue Flaeche sichtbar. Chromium misst fuer das Select `rgb(236, 236, 244)`; die umgebende Menueflaeche erscheint weiss. [Screenshot](../evidence/nil-609/06-language-selector-color.png)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Nachweis der Icon-Quellen

- `frontend/package.json` fuehrt `@excalidraw/excalidraw` 0.18.1 und `lucide-react` 0.554.x
  parallel als direkte Abhaengigkeiten.
- `frontend/src/pages/editor/chromeSlots.tsx` importiert die ExcaliDash-Menue- und
  Header-Icons aus `lucide-react`; der Share-Button rendert dort `Share2`.
- `frontend/src/pages/editor/WorkshopTimerCorner.tsx` importiert `GripVertical` und
  `RotateCcw` aus `lucide-react`.
- `frontend/src/integrations/excalidraw/ExcalidrawHost.tsx` mountet
  `@excalidraw/excalidraw`; dessen `DefaultSidebarTrigger` rendert das Library-Icon.

## Verifikation

```text
NO_SERVER=true BASE_URL=http://localhost:8611 API_URL=http://localhost:8610 PORT=8610 \
  npx playwright test tests/canvas-chrome.spec.ts \
  tests/workshop-timer-position.spec.ts --project=chromium --retries=0 --reporter=list

20 passed
```

Die Browsermessung selbst erzeugte die sechs Screenshots und pruefte zusaetzlich den
Positionswechsel des Timers sowie die DOM- und CSS-Werte in `metrics.json`.
