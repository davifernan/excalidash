# Excalidraw Compatibility Layer

Status: Architecture Decision und Umsetzungsvertrag
Operative Roadmap: Multica-Context-Epic `NIL-322`
Entscheidung: ExcaliDash bleibt npm-basierter Host und forkt den Excalidraw-Core nicht.

## Kontext

ExcaliDash bindet `@excalidraw/excalidraw` als npm-Paket ein. Ein Teil der Integration nutzt
offizielle Props, Children Components und die Excalidraw API. Andere Funktionen greifen auf
interne CSS-Klassen, DOM-Struktur, Tastaturverhalten oder Annahmen ueber Elementordnung zu.

Diese Abhaengigkeiten sind heute ueber Editor-, Sticky-, Follow-, Widget- und Exportcode
verteilt. Ein Paketupgrade erzeugt deshalb keine klassischen Git-Mergekonflikte, kann aber
an beliebigen Produktstellen Laufzeitverhalten brechen.

## Entscheidung

Zwischen ExcaliDash und Excalidraw wird eine Anti-Corruption-/Compatibility-Schicht gebaut.
Produktcode verwendet fachliche ExcaliDash-Capabilities. Nur diese Schicht kennt die rohe
Excalidraw API, interne Typen, DOM-Struktur und Fallbacks.

Die Migration erfolgt ohne dauerhafte Kompatibilitaetsschicht:

- Ein migrierter Zugriff wird am alten Ort entfernt.
- Kein Feature-Flag haelt alten und neuen Weg parallel am Leben.
- Lokale Adaptertypen ersetzen rohe Editorinterna im Produktcode.
- Bei einer unzureichenden alten Abstraktion wird der Vertrag gebrochen und direkt sauber
  angepasst; es gibt keine Legacy-API fuer bisherige interne Aufrufer.

## Ziele

- Excalidraw-Upgrades haben eine lokalisierte Auswirkung.
- Fragile Kopplungen sind sichtbar, messbar und zentral testbar.
- Produktfeatures formulieren Absichten statt Editorimplementierung.
- Fehlende Capabilities besitzen explizite Fehler oder Fallbacks.
- Kommentare, Frame Navigator, Praesentation und Canvas Shell bauen auf einem gemeinsamen
  Vertrag statt auf neuen Einzelloesungen.

## Nicht-Ziele

- alle Excalidraw-APIs spiegeln
- jede interne Editorfunktion abstrahieren
- Excalidraw-Quellcode vendoren
- UI pixelgenau gegen interne Klassen patchen
- alte ExcaliDash-Integrationssignaturen erhalten

## Stability-Klassen

### Public

Offiziell angebotene Props, Children Components, Excalidraw API und Utilities, zum Beispiel:

- `onChange`, `onPointerDown`, `onPointerUpdate`
- `renderEmbeddable`, `renderTopRightUI`
- `MainMenu`, `Sidebar`, `Footer`
- `excalidrawAPI`, `updateScene`, `scrollToContent`, `addFiles`
- `customData`
- Export-/Restore-Utilities

Diese APIs werden trotzdem ueber lokale Capabilities konsumiert, damit Produktcode nicht an
deren konkrete Signatur gebunden ist.

### Typed internal

Im Paket typisierte Strukturen, deren Stabilitaet nicht als Produktvertrag garantiert ist:

- Element- und AppState-Details
- Frame-/Binding-Felder
- interne File-/Collaborator-Formen

Sie duerfen nur in Adaptermodulen auftreten und werden an der Grenze normalisiert.

### DOM internal

- `.App-toolbar`, `.Stack_horizontal`, `.excalidraw--mobile`
- Zen-/Mobile-Klassen
- synthetisches `Enter` zum Oeffnen eines Texteditors
- manuelles Canvas-/Element-Hit-Testing
- Annahmen ueber interne Portal- oder Overlay-Struktur

Diese Zugriffe liegen ausschliesslich in `domBridge.ts` beziehungsweise einem klar benannten
Untermodul. Jeder Zugriff braucht Capability Detection, Fallback und Browsertest.

## Zielstruktur

```text
frontend/src/integrations/excalidraw/
├── ExcalidrawHost.tsx
├── adapter.ts
├── capabilities.ts
├── errors.ts
├── types.ts
├── scene.ts
├── selection.ts
├── files.ts
├── viewport.ts
├── collaboration.ts
├── widgets.tsx
├── export.ts
├── uiSlots.tsx
├── customData.ts
├── geometry.ts
├── domBridge.ts
└── compatibility/
    ├── diagnostics.ts
    ├── contract.test.tsx
    └── seamMatrix.ts
```

Die genaue Dateiteilung darf sich waehrend Stage 1 aendern. Verbindlich ist die
Abhaengigkeitsrichtung:

```text
Product feature -> local capability -> Excalidraw adapter -> Excalidraw
                                      -> DOM bridge (nur wenn unvermeidbar)
```

Rueckwaertsabhaengigkeiten sind verboten.

## Capability-Vertrag

Die Signaturen werden in M1 Stage 1 final typisiert. Der fachliche Umfang ist bereits
verbindlich.

### SceneCapability

- aktuelle, nicht geloeschte oder vollstaendige Szene lesen
- Szene atomar aktualisieren
- Elemente anhand lokaler IDs normalisieren
- Board-Settings getrennt von fluechtigem AppState behandeln

### SelectionCapability

- selektierte Elemente als lokale Referenzen liefern
- Auswahl setzen und loeschen
- Aenderung der Auswahl abonnieren
- Kommentaranker aus Auswahl oder Canvas-Punkt erzeugen

### FileCapability

- Files lesen und hinzufuegen
- Delta gegen bestaetigten Serverzustand bilden
- komprimierbare Persistenzdaten vom Editor-Sync-Baselinezustand trennen
- Fehler und Ablehnungen strukturiert zurueckgeben

### ViewportCapability

- zu Element, Frame oder Canvas-Koordinate navigieren
- Follow-/Presenter-Ziel anwenden
- Zoom/Scroll normalisieren
- mobile und Desktop-Viewportunterschiede kapseln

### WidgetCapability

- ExcaliDash-Widget aus `customData` erkennen
- Widgetdaten versioniert validieren
- interaktive Darstellung und Read-only-Verhalten
- Exportersatz erzeugen

### UiCapability

- offizielle MainMenu-, Sidebar-, Footer- und Top-Right-Slots befuellen
- optionale Toolbar-Aktion ueber DOM Bridge
- Mobile-/Zen-Capability melden
- bei fehlender Toolbar einen sichtbaren Menue-Fallback anbieten

### ExportCapability

- exportierbare Klonszene erzeugen
- Widgets durch stabile Exportelemente ersetzen
- Metadaten/Kommentare nur nach expliziter Exportentscheidung aufnehmen

### CompatibilityCapability

- Paketversion melden
- erwartete oeffentliche und fragile Capabilities pruefen
- Diagnostik fuer Entwicklung und Tests liefern
- harte Inkompatibilitaet von degradierbarer Capability unterscheiden

## Fehler- und Fallback-Modell

Fragile Integrationen duerfen nicht still ausfallen.

```ts
type CapabilityResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "unsupported" | "not-ready" | "invalid-state" | "editor-changed";
      fallback?: "main-menu" | "manual-selection" | "static-widget";
    };
```

Beispiele:

- Sticky-Toolbar fehlt: Aktion erscheint im Main Menu.
- Instant Typing kann nicht gestartet werden: Sticky bleibt selektiert und UI erklaert Enter
  beziehungsweise Doppelklick.
- interaktives Widget ist im Read-only-Modus nicht aktivierbar: eindeutiger statischer
  Lesemodus statt wirkungsloser Buttons.

### Meldbarkeit

Noch nicht gebaut. Dieser Abschnitt beschreibt wie der Rest des Dokuments den Zielzustand;
umgesetzt wird er in NIL-333 (Vertrag) und NIL-335 (Fundament).

`CapabilityResult` ist ein Rueckgabewert, keine Ausnahme. Das ist gewollt: ein Fallback ist ein
erwartetes Ergebnis, kein Ausnahmefall. Es hat aber eine Konsequenz, die ausgesprochen werden
muss: **ein nicht-`ok`-Ergebnis wirft nie, also sieht es ausserhalb des Aufrufers niemand.**

Das trifft ausgerechnet `code: "editor-changed"` — die Meldung "ein Upgrade hat einen Seam
gebrochen, bei einem echten Nutzer". Genau das findet der Canary-Lauf per Konstruktion nicht,
weil er nur die eigenen Testpfade abgeht.

Deshalb gehoert zum Vertrag eine Senke:

- Jedes nicht-`ok`-Ergebnis ist meldbar. Der Vertrag definiert die Form der Meldung —
  Capability, `code`, gewaehlter Fallback, Excalidraw-Paketversion — nicht ihr Ziel.
- Die Senke ist eine Abo-Schnittstelle in `compatibility/diagnostics.ts`, kein Import. Die
  Abhaengigkeitsrichtung bleibt unveraendert: die Integrationsschicht importiert nichts aus der
  Produkt- oder App-Schicht, die App-Shell registriert sich.
- Ohne registrierten Abonnenten aendert sich nichts. Kein Fallback haengt davon ab, dass jemand
  zuhoert.
- Eine Meldung enthaelt keine Boardinhalte, keine Elementtexte und keine Nutzerkennung.

Ein Absturz im Renderbaum ist der Fall, den diese Senke nicht abdeckt: er wirft, statt ein
Ergebnis zurueckzugeben. `ExcalidrawHost` erhaelt dafuer einen eigenen ErrorBoundary, damit ein
Fehler aus dem Editor den Canvasbereich kostet und nicht die Anwendung — Bestandteil von
NIL-335, gemeinsam mit dem Host selbst. Bis dahin faengt ein solcher Fehler erst das aeussere
Netz um den gesamten Routenbaum ab, das ausserhalb dieser Schicht liegt und nicht ihre Aufgabe
ist.

## `customData`-Vertrag

Alle ExcaliDash-Daten auf Elementen erhalten:

- einen Namespace
- `schemaVersion`
- Laufzeitvalidierung
- eine einzige aktuelle Zielversion

Alte interne Formen werden waehrend der Migration einmalig normalisiert und danach nicht als
zweiter Codepfad weitergefuehrt.

Kommentare speichern ihren fachlichen Inhalt serverseitig. `customData` enthaelt hoechstens
eine stabile Referenz oder Darstellungshilfe, niemals die Autoritaetsquelle fuer Rechte,
Autorschaft oder Threadzustand.

## Durchsetzung

Nach Stage 2 wird ein Architekturcheck eingefuehrt:

- Runtime-Imports aus `@excalidraw/excalidraw` nur in der Integrationsschicht und dem
  unmittelbaren Host-Einstiegspunkt.
- Type-only-Imports werden ebenfalls bevorzugt ueber `integrations/excalidraw/types`
  re-exportiert.
- bekannte interne Selektoren duerfen nur im DOM-Bridge-Verzeichnis vorkommen.
- synthetische Keyboard Events duerfen nur dort erzeugt werden.
- direkte `customData`-Schreibzugriffe ausserhalb des zentralen Helpers sind verboten.

Die Regel wird automatisiert, nicht nur dokumentiert.

## Migrationsstufen

### Stage 1: Inventar und Tests

- alle Imports, Selektoren und synthetischen Events erfassen
- Feature-zu-Seam-Matrix erstellen
- heutiges Verhalten durch Contract-/E2E-Tests einfrieren
- Capability-Vertrag finalisieren

### Stage 2: Fundament

- Host, lokale Typen und Adapterinstanz
- Scene, Selection, Files, Viewport
- Widgets/Export/UI Slots
- DOM Bridge und Diagnostics
- Architekturcheck aktivieren, sobald die erlaubte Baseline definiert ist

### Stage 3: Verbraucher migrieren

Je Feature ein reviewbarer Schnitt. Alte Implementierung im selben Schnitt loeschen.

### Stage 4: Hardening

- Mobile, Firefox und WebKit
- Sticky Instant Typing und Frames
- Widget Read-only und Export
- Canary-Paketupgrade
- verbleibende Ausnahmen beseitigen oder als bewusstes DOM-Bridge-Contract dokumentieren

## Testpyramide

### Unit

- Normalisierung lokaler Typen
- Capability-Fehler und Fallbackauswahl
- `customData`-Validierung
- Geometrie und Exportersatz

### Contract

- Adapter gegen die gepinnte Excalidraw-Version
- zentrale API-/DOM-Erwartungen
- keine verbotenen Imports/Selektoren

### Browser

- Sticky erstellen und sofort tippen
- Toolbar und Main-Menu-Fallback
- Mobile und Zen Mode
- Widget interaktiv/read-only/exportiert
- Follow/Viewport
- Framezuordnung und verschachtelte Frames
- Kommentare/Deep Links, sobald M3 beginnt

### Canary

Ein separater regelmaessiger Lauf installiert bewusst die naechste zu pruefende
Excalidraw-Version und fuehrt Contract plus kritische Browserpfade aus. Canary-Fehler blockieren
nicht automatisch die aktuelle Entwicklung, erzeugen aber ein sichtbares Upgrade-Issue.

## Definition of Done

- ein aktiver Integrationspfad, keine Legacy-Duplikate
- oeffentliche und fragile Seams vollstaendig klassifiziert
- Adapter ist der einzige Runtime-Zugang
- DOM Bridge ist klein, sichtbar und getestet
- jedes Fehlschlagen hat strukturiertes Ergebnis oder UI-Fallback
- Produktfeatures kennen keine Excalidraw-DOM-Klassen
- kritische Chromium-, Firefox-, WebKit- und Mobile-Vertraege sind gruen
- Upgrade-Runbook wurde einmal praktisch durchlaufen
