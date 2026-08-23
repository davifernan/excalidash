# Upstream-Sync-Rehearsal-Log

Fortlaufendes Protokoll jeder tatsächlich durchgeführten Ausführung der in
[UPSTREAM_MAINTENANCE.md](./UPSTREAM_MAINTENANCE.md) beschriebenen Routine -- neue Einträge oben
anhängen. Ein Rehearsal, das nur beschrieben und nie ausgeführt wurde, hat den Fork nicht
getestet.

## 2026-08-23 -- erstes Rehearsal (NIL-367/368)

**Ausgeführt von:** Package NIL-327, Session `bb2d087f-ddfa-4cd0-8d8f-03ac714f776c`, isoliert in
`/tmp/.../scratchpad/upstream-rehearsal` (Wegwerf-Worktree von `fork/main`, danach vollständig
gelöscht -- nichts davon fließt in diesen PR ein).

### Kanal 1: ExcaliDash-Anwendungsupstream -- `origin/main` UND `origin/alpha`

Erste Fassung dieses Log-Eintrags prüfte nur `origin/main` und schloss daraus "nichts zu
syncen". Das war eine Messung am falschen Objekt (siehe NIL-378, bereits vorher recherchiert):
`origin/main` steht seit dem Fork still, die tatsächliche Upstream-Entwicklung läuft auf
`origin/alpha`. Korrigiert:

```
git fetch origin main
git log --oneline fork/main..origin/main | wc -l    # 0

git fetch origin alpha
git log --oneline fork/main..origin/alpha | wc -l   # 9
git merge-base fork/main origin/alpha               # 294097c (gemeinsame Basis)
git log --oneline origin/alpha..fork/main | wc -l    # 166 (unser Vorsprung seit der Basis)
```

`origin/main` ist zu 100% in `fork/main` enthalten -- dort gibt es nichts zu mergen, weil
upstream dort nicht mehr arbeitet. `origin/alpha` dagegen hat 9 Commits (244 Dateien, ~30.000
Zeilen laut NIL-378) seit der gemeinsamen Basis `294097c`, die wir nicht haben. Ein Merge davon
wurde in diesem Rehearsal **nicht** geprobt -- NIL-378 hat bereits eine inhaltliche Bewertung
vorgenommen (u.a.: der kritischste eigene Befund NIL-315 ist auf `alpha` nicht gelöst, vier von
sieben dort gelöschten Dateien werden vom Fork benutzt, `alpha` löscht die Root-`README.md`) und
das ist eine Produktentscheidung des Package-Owners, keine Mechanik, die dieses Rehearsal für
sich klären kann. Ein echter Merge-Versuch von `origin/alpha` bleibt damit bewusst offen für die
Entscheidung, die NIL-378 verlangt, nicht aus Zeitmangel ungetestet.

Die Routine aus Schritt 1-2 der Sync-Anleitung (`upstream-sync/YYYY-MM-DD` anlegen, echt mergen)
bleibt gegen `origin/main` ungetestet gegen einen echten Konflikt, weil dort keiner ansteht. Wer
als Nächstes synct, sollte das nicht als Bestätigung lesen, dass Schritt 3-5 (fachliche
Konfliktlösung, `range-diff`) funktionieren -- nur, dass sie heute nicht gebraucht wurden.

### Kanal 2: Excalidraw-Editorupstream (`@excalidraw/excalidraw`)

```
grep '"@excalidraw/excalidraw"' frontend/package.json   # 0.18.1
npm view @excalidraw/excalidraw version                 # 0.18.1
```

Ebenfalls bereits auf der neuesten verfügbaren Version gepinnt. Kein Canary-Upgrade zu proben,
aus demselben Grund wie oben.

### Die Kompatibilitätsgrenze selbst geprobt (Rot-Probe)

Weil beide Kanäle heute nichts Neues liefern, wäre "Rehearsal ausgeführt" ohne echten Beleg
wertlos. Stattdessen wurde geprüft, ob `verifySeams()`/`verifyExports()`
(`frontend/src/integrations/excalidraw/compatibility/seams.ts`) eine **echte** Regression im
**tatsächlich installierten** Paket erkennt, nicht nur an einer Mock-Attrappe:

1. Baseline: `npx vitest run src/integrations/excalidraw/compatibility` -- 20/20 grün.
2. Im installierten Paket (`node_modules/@excalidraw/excalidraw/dist/{dev,prod}/index.js`) den
   öffentlichen Export `zoomToFitBounds` in der finalen `export {...}`-Anweisung umbenannt
   (chirurgisch, nur die Export-Zeile, nicht die interne Definition oder ihre Aufrufer -- das
   Bundle bleibt sonst syntaktisch gültig).
3. Test erneut: 1 von 20 rot, mit exakt der erwarteten Meldung:
   ```
   expected [ 'zoomToFitBounds' ] to deeply equal []
   ```
4. Wegwerf-Worktree komplett entfernt (`git worktree remove --force`), keine der beiden Dateien
   zurückgespielt -- das Original lag ohnehin nur in einem gelöschten `node_modules`-Baum.

**Befund:** `verifyExports()` erkennt einen physisch aus dem installierten Paket entfernten
öffentlichen Export zuverlässig, nicht nur simulierte Fälle über Objekt-Attrappen. Die
Kompatibilitätsgrenze aus M1 hält, wenn sie tatsächlich geprüft wird -- nicht nur, wenn ihr
eigener Test sie prüft.

### Offen für das nächste Rehearsal

Ein echter Merge-Konflikt und ein echtes Versions-Upgrade sind hier nicht durchgespielt worden,
weil aktuell keiner ansteht. Sobald `origin/main` oder `@excalidraw/excalidraw` sich bewegen,
ist das die Gelegenheit, die Routine gegen einen echten Fall statt gegen eine simulierte
Regression zu prüfen -- und diesen Log-Eintrag fortzuschreiben, nicht zu ersetzen.
