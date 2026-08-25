# ExcaliDash Product Vision

Status: verbindliches Zielbild fuer die naechste Produktphase
Arbeitsstand: 2026-08-22
Operativer Backlog: Multica-Projekt `ExcaliDash Fork` (`dd3eb382-f547-41ac-8be2-be225704e791`)
Lebende Roadmap: `NIL-320`, Meilenstein-Context-Epics `NIL-321` bis `NIL-327`

## Produktthese

ExcaliDash wird der selbst gehostete, canvas-first Projektraum fuer kleine Teams.

Excalidraw bleibt die Zeichenmaschine. ExcaliDash macht daraus einen Ort, an dem ein Team
Arbeit findet, gemeinsam bearbeitet, bespricht, praesentiert und spaeter mit dem notwendigen
Kontext fortsetzt.

Der primaere Zielkontext ist ein Team von ungefaehr zehn Personen. Das Produkt wird fuer
dieses Team richtig gebaut und nicht fuer hypothetische Altinstallationen, Drittanbieter oder
Enterprise-Skalierung verbogen.

## Verbindliche Greenfield-Regel

Fuer die kommende Architekturphase gibt es keine Legacy-Kompatibilitaetspflicht.

- Interne APIs, Komponenten, Datenmodelle und Verzeichnisstrukturen duerfen ersetzt werden.
- Es werden keine dauerhaften Alt-/Neu-Pfade, Kompatibilitaetsschichten oder Feature-Flag-
  Zwischenwelten aufgebaut.
- Nach einer Migration wird der alte Pfad im selben Arbeitspaket entfernt.
- Bestehende Entwicklungsdaten koennen einmalig migriert oder bewusst neu aufgebaut werden;
  daraus entsteht kein dauerhaft zu wartender Legacy-Code.
- Rueckwaertskompatibilitaet wird nur dort geschaffen, wo sie Bestandteil des neuen
  Produktvertrags ist, nicht fuer unbekannte fremde Instanzen.

"Direkt richtig" bedeutet trotzdem nicht "alles in einem Commit": Die Zielarchitektur wird in
kleinen, pruefbaren Schritten gebaut, aber jeder Schritt endet in einem eindeutigen Zielzustand.

## Das Problem, das wir loesen

Der heutige Fork besitzt bereits einen starken technischen Unterbau: persistente Boards,
Echtzeit-Zusammenarbeit, Teamfreigaben, Presence, Follow Mode, Sticky Notes, Dokumente,
Version History, Backups, Workshop-Timer und Agentenzugriff.

Diese Faehigkeiten ergeben noch keine zusammenhaengende Produkterfahrung. Nutzern fehlen vor
allem Antworten auf sechs Fragen:

1. Wo bin ich und zu welchem Team-/Projektkontext gehoert dieses Board?
2. Wer arbeitet gerade woran?
3. Was ist passiert, seit ich zuletzt hier war?
4. Wie gebe ich Feedback, ohne gleichzeitig im Board sein zu muessen?
5. Wie finde ich ein Board oder eine wichtige Stelle schnell wieder?
6. Wie wird aus Frames ein moderierter Workshop oder eine Praesentation?

## Ziel-Nutzungsschleife

```text
Team Home
  -> neue Aktivitaet und anwesende Personen sehen
  -> Board ohne Kontextwechsel oeffnen
  -> im Canvas erstellen, kommentieren und entscheiden
  -> Erwaehnung oder Aktivitaet erzeugen
  -> spaeter direkt an die relevante Stelle zurueckkehren
```

Jeder groessere Produktbaustein muss diese Schleife staerken. Features ohne klaren Platz in
diesem Ablauf werden nicht allein deshalb gebaut, weil sie technisch interessant sind.

## Produktpfeiler

### 1. Team Home

Das Dashboard wird von einer Dateiliste zu einem Arbeitsstartpunkt:

- zuletzt verwendete und favorisierte Boards
- aktuelle Teamaktivitaet
- wer gerade in welchem Board arbeitet
- klare Team-/Collection-Navigation
- globale Suche und Command Palette
- verstaendliche Berechtigungen und Empty States

### 2. Canvas Workspace

Das Board fuehlt sich nicht wie ein fremd eingebetteter Editor an:

- sichtbarer Board- und Teamkontext
- schneller Boardwechsel
- konsistente Seitenleisten und Panels
- Kommentare und Aktivitaet direkt am relevanten Canvas-Kontext
- Dokumente, Sticky Notes, Mind Maps und weitere ExcaliDash-Objekte als natuerliche Bestandteile

### 3. Asynchrone Zusammenarbeit

Zusammenarbeit darf nicht davon abhaengen, dass alle gleichzeitig online sind:

- Kommentare und Threads
- Mentions und Benachrichtigungen
- Autorenschaft und nachvollziehbare History
- "seit deinem letzten Besuch"
- Deep Links zu Board, Element oder Canvas-Position

### 4. Workshops und Praesentationen

Frames werden zu einer gefuehrten Arbeitsform:

- Frame Navigator
- Praesentationsmodus
- Presenter Notes
- Workshop-Timer und Moderationsaktionen
- verdeckte Abstimmungen
- wiederverwendbare Workshop-Vorlagen

### 5. Wiederfinden und Wiederverwenden

- globale Board- und spaeter Inhaltssuche
- Recent, Favorites und Archiv
- gemeinsame Team Library
- Templates
- klare Herkunft und Eigentumsinformationen

### 6. Vertrauenswuerdige Plattform

- deterministische Synchronisation
- keine still verlorenen Aenderungen oder Dateien
- explizite Limits und strukturierte Fehler
- reproduzierbare Builds
- klare Excalidraw-Kompatibilitaetsgrenze
- messbare Browser- und Kollaborationsvertraege

## Produktprinzipien

1. **Canvas first:** Der Canvas ist das Zentrum; das Dashboard hilft beim Einstieg und
   Wiederfinden.
2. **Teamkontext sichtbar:** Eigentum, Anwesenheit und Aktivitaet duerfen nicht versteckt sein.
3. **Server entscheidet ueber gemeinsamen Zustand:** Gemeinsame Seiten, Kommentare,
   Abstimmungen und Aktivitaet haben eine serverseitig geordnete Wahrheit.
4. **Keine stillen Fehler:** Ablehnung, Timeout und fehlende Capability werden strukturiert
   sichtbar und testbar.
5. **Eine Zielarchitektur:** Nach Migrationen existiert genau ein aktiver Pfad.
6. **Oeffentliche Excalidraw-APIs zuerst:** Interne DOM-Bruecken werden zentral isoliert und
   erhalten einen sichtbaren Fallback.
7. **Vertikale Produktschnitte:** Ein kompletter Nutzerablauf ist wertvoller als viele halbe
   Infrastrukturteile.
8. **Fuer zehn Menschen exzellent:** Wir optimieren nicht vorzeitig fuer hunderte gleichzeitige
   Nutzer.

## Bewusste Nicht-Ziele der naechsten Roadmap

- eigener dauerhafter Fork des Excalidraw-Quellcodes
- 1:1-Kopie aller Excalidraw+-Funktionen
- Voice Chat oder Screensharing
- native Tabellen-, Layer- oder Rich-Text-Engine im Excalidraw-Core
- vollstaendige Offline-/PWA-Architektur
- Enterprise-Mandantenfaehigkeit
- breit angelegter AI-Assistent vor Fertigstellung der Teamablaeufe
- Legacy-Unterstuetzung fuer fremde ExcaliDash-Installationen

## Erfolgskriterien

Die Produktphase ist erfolgreich, wenn ein Teammitglied ohne Erklaerung:

- in weniger als zwei Aktionen ein zuletzt relevantes Board erreicht,
- sieht, wer gerade wo arbeitet,
- eine Rueckfrage an einem Element oder Ort hinterlassen kann,
- eine Mention erhaelt und direkt zur gemeinten Stelle gelangt,
- nach Abwesenheit die relevanten Aenderungen versteht,
- Frames als gefuehrte Praesentation verwenden kann,
- ein Board ueber Namen, Inhalt, Favorit oder Aktivitaet wiederfindet.

Technisch gilt Erfolg, wenn ein Excalidraw-Upgrade nur die definierte Integrationsschicht und
ihre Contract-Tests beruehrt, statt Produktcode im gesamten Frontend zu brechen.

## Entscheidungsregel fuer neue Ideen

Eine Idee kommt nur in die aktive Roadmap, wenn mindestens eine Frage klar beantwortet ist:

- Welchen Schritt der Ziel-Nutzungsschleife verbessert sie?
- Welchen heute beobachteten Teambruch beseitigt sie?
- Welches technische Risiko blockiert ohne sie die naechste Produktstufe?

Andernfalls bleibt sie Research oder Backlog.
