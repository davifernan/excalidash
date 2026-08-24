# Workshop and Presenter: Presenting, Frames, Notes, Voting, Templates

Status: verbindlicher Produktvertrag fuer NIL-325 (M4)
Arbeitsstand: 2026-08-24
Betroffene Vertraege: `backend/src/server/{presenterRegistry,socketPresenter,votingRegistry,socketVoting}.ts`,
`frontend/src/pages/editor/{presenterMode,votingMode,frameNavigator,workshopTemplates}.ts`,
`frontend/src/pages/editor/{PresentationOverlay,VotingOverlay}.tsx`

Sibling zu `docs/product/COLLABORATION_NAVIGATION.md`, das dieses Paket direkt fortschreibt
("Was M4 uebernehmen kann"). Wo dieses Dokument von dort nicht abweicht, wird es nicht
wiederholt.

## Warum kein zweiter Presence-Begriff

Ein Presenter mit Zuschauern ist Follow mit einer Autoritaet obendrauf, kein neues Konzept.
Der entscheidende Unterschied: Follow ist eine Eins-zu-eins-Kante (`userToFollow`), die jede
folgende Person selbst eingeht. Praesentieren ist ein Raum-weiter Broadcast von genau einer
Autoritaet — es gibt keine N parallelen `follow-user`-Kommandos, keine explizite
Zuschauer-Anmeldung. Wer im Raum ist, empfaengt den Broadcast; ob die eigene Ansicht
mitgezogen wird, ist eine rein lokale, jederzeit umkehrbare Entscheidung (`following`,
Default `true`) — der Server weiss nichts davon und muss es auch nicht: der Presenter
praesentiert weiter fuer alle anderen im Raum, unabhaengig davon, ob eine einzelne Person
gerade folgt.

## Der Server-Vertrag

Genau ein Presenter pro Zeichnung, gehalten in `PresenterRegistry` (In-Memory, nicht
persistiert — dieselbe Konvention wie `presenceRegistry.ts`, `socketWorkshopTimer.ts`: ein
Fakt ueber offene Verbindungen, kein Datenbank-Zustand).

```
PresenterSnapshot = {
  drawingId, status: "idle" | "presenting",
  presenterPresenceId, presenterName,
  frameId: string | null,   // null = freeform pan, nicht auf einem benannten Frame
  bounds: SceneBounds | null,
  revision: number,
}
```

**Wer praesentieren darf.** `canEditDrawing`-Niveau, derselbe Massstab wie Editieren, nicht
nur Sehen. Praesentieren bewegt den geteilten Blick des ganzen Raums — das ist eine
autoritative Handlung, keine Annotation. Ein `"comment"`-Nutzer (dritte Rechtestufe seit
NIL-487) darf zusehen und kommentieren, aber nicht praesentieren. Diese Entscheidung war im
Kickoff ausdruecklich offen ("Ueberlege, ob ein Kommentierender praesentieren darf") — hier
bewusst getroffen, nicht implizit aus `canEditDrawing` herausgefallen.

**Konkurrierende Presenter.** Ein zweiter `start`-Versuch waehrend jemand bereits
praesentiert wird mit `presenter-active` abgelehnt. Der Eigentuemer der Zeichnung kann jederzeit
per `takeover` uebernehmen (setzt den aktiven Presenter ab, wird selbst Presenter) oder per
`stop` mit `force` die laufende Praesentation beenden, ohne selbst zu uebernehmen. Ein
Nicht-Eigentuemer-Editor kann weder das eine noch das andere gegen eine fremde Praesentation.

**Wie eine Praesentation endet.** Vier Wege, symmetrisch zu Follows "endet an genau vier
Bedingungen" aus `COLLABORATION_NAVIGATION.md`: der Presenter stoppt selbst, der Eigentuemer
beendet erzwungen, der Presenter uebernimmt via `takeover` (implizit: die alte Sitzung endet),
oder der Presenter-Socket trennt sich wirklich (`removeFromDrawing`, jeder seiner Gruende —
echter Disconnect, Board-Wechsel, Rechteentzug). **Nicht** dabei: `isActive: false`. Die
Inaktiv/Disconnect-Unterscheidung aus `COLLABORATION_NAVIGATION.md` gilt unveraendert — ein
Presenter, dessen Tab kurz den Fokus verliert, praesentiert weiter. Getestet in
`socketPresenter.test.ts` ("does not end presenting when the presenter only goes
tab-inactive").

**Konvergenz und veraltete Revisionen.** Kein client-seitig mitgeschickter
Optimistic-Concurrency-Token. Nur der aktuell erkannte Presenter-Socket darf `advance`/`stop`
ohne `force` ausloesen (`PresenterRegistry.isPresenter`, synchron gegen die Map geprueft, kein
`await` zwischen Pruefung und Schreiben) — ein bereits abgesetzter Presenter wird in dem
Moment nicht mehr erkannt, in dem `takeover`/`stop` laeuft, ohne dass eine verspaetete
Nachricht von ihm noch etwas bewegen koennte. `revision` ist fuer Clients: eine monoton
steigende Zahl, um "habe ich das schon angewendet" ueber einen Reconnect hinweg zu erkennen,
nicht der Mechanismus, der die Konvergenz erzwingt — der erzwingt sie ueber Autorisierung.

**Framewechsel und freies Schwenken teilen einen Kanal.** Ein Klick auf ein Frame im Navigator
sendet `frameId: <id>` einmalig und sofort; jede folgende Kamerabewegung (Scrollen, Zoomen)
sendet `frameId: null`, bis der Presenter das naechste Mal bewusst ein Frame anklickt. Kein
Client rechnet aus, "auf welchem Frame die Kamera gerade ungefaehr ist" — das waere geraten,
nicht deklariert. Ein benannter Sprung wird nicht-volatile gesendet (darf nicht verloren
gehen), ein freies Schwenken volatile (darf, wie `viewport-bounds` bei Follow).

## Presenter Notes: streng auf den Presenter beschraenkt

Nicht Teil des `PresenterSnapshot` — ein komplett getrennter, nie gebroadcasteter Kanal.
`PresenterRegistry` haelt eine zweite Map (`drawingId -> frameId -> text`), gelesen und
geschrieben ausschliesslich von einem Socket, das in genau diesem Moment
`PresenterRegistry.isPresenter(drawingId, socket.id)` erfuellt — geprueft bei jedem Schreiben,
nicht nur beim Praesentationsstart. Der Server **pusht** die Notizen des aktuellen Frames
proaktiv an den Presenter (bei `start`, `takeover` und jedem `advance`), damit es keinen
Request/Response-Zyklus braucht, den ein Zuschauer theoretisch auch anstossen koennte.

Bewusste Nicht-Ziele: Notizen ueberleben keinen Presenter-Wechsel (wer praesentiert, ist an den
Socket gebunden, Notizen bleiben serverseitig unter der Zeichnung liegen und sind fuer den
naechsten Presenter dort wieder da, sofern derselbe Prozess laeuft) und keinen Server-Neustart
(In-Memory, wie der Rest dieser Schicht). Kein Vorbereiten von Notizen ausserhalb einer
laufenden Praesentation in dieser Version — wer Notizen schreiben will, muss praesentieren.
Als Grenze bewusst gezogen, nicht uebersehen: Acceptance verlangt "nur fuer berechtigten
Presenter", nicht "auch im Vorbereitungsmodus".

**Warum nicht in `customData` auf dem Frame-Element.** Das waere die naheliegende, aber
falsche Antwort: die Szene wird an jeden mit Sichtrecht gleich gesynct (siehe
Kollaborations-Merge), also waere jede Notiz technisch fuer die Audience lesbar — genau das
Leck, das `"Zwischenstand ist technisch nicht ueber API/Socket lesbar"` fuer Voting explizit
verbietet und das hier fuer Notizen ebenso gilt, auch ohne dass es fuer Notizen woertlich so
im Ticket steht.

## Praesentationsoberflaeche: eine Komponente, zwei Rollen

`PresentationOverlay.tsx` ist eine einzige State-Machine, keine zwei getrennten Komponenten:
`presenting.isSelf` (aus `PresenterSnapshot.presenterPresenceId === eigene Socket-Id`)
entscheidet, ob das Presenter-Panel (Frame-Navigator, Notizen, Stop) oder das
Audience-Banner ("X praesentiert", Folgen/Nicht-folgen-Umschalter, bei Eigentuemer:
Uebernehmen) gerendert wird. Rendert **nichts**, solange `status === "idle"` — dieselbe
leere-Slot-Konvention wie `chromeSlots.tsx` fuer die eigenen Registries dokumentiert.

**Was passiert, wenn der Presenter zeichnet? Was, wenn ein Zuschauer es tut?** Bewusst
entschieden, nicht dem Zufall ueberlassen: **gar nichts Besonderes.** Praesentieren aendert
keine Editierrechte. Der Presenter zeichnet wie jeder Editor, sichtbar in Echtzeit fuer alle —
normale Kollaboration, keine Praesentations-Sonderbehandlung. Ein Zuschauer mit Editierrecht
kann waehrenddessen genauso zeichnen; das ist ebenfalls normale Kollaboration. Praesentieren
kontrolliert ausschliesslich den geteilten Kamera-/Frame-Zustand, nichts an Bearbeitungsrechten.
Diese Trennung ist damit strukturell erzwungen (kein Code verbindet die beiden Zustaende), nicht
nur per Konvention behauptet.

**Tastatursteuerung.** Pfeil rechts/runter/Leertaste = naechstes Frame, Pfeil links/hoch =
vorheriges — nur fuer den Presenter, nur wenn der Fokus nicht in einem Eingabefeld liegt
(`isEditableTarget`-Check), sonst wuerde ein Pfeiltastendruck im Notizen-Textfeld ungewollt das
Frame wechseln.

## Frame Navigator (NIL-284)

Liest `scene.summaries()`, filtert auf `type === "frame" | "magicframe"`, in Dokumentreihenfolge
(Erstellungsreihenfolge — dieselbe Reihenfolge, in der ein Template seine Frames einfuegt).
Kein Rename hier: NIL-325s Scope ist Auflisten und Springen, nicht Frame-Umbenennung (bleibt
Excalidraws eigener Doppelklick).

**Additive Anpassung am Adaptervertrag:** `ElementSummary` bekommt `name: string | null`
(`frontend/src/integrations/excalidraw/types.ts`, `adapter.ts`s `summarise()`). Ohne dieses
Feld liesse sich ein handgezeichnetes Frame nicht mit seinem Namen auflisten. Additiv im Sinne
der Regel vom 23.08.: kein Funktionsverlust, ein zusaetzliches Feld.

## Voting: verdeckt, weil es strukturell nicht anders geht

`VotingRegistry` kennt **keine Methode**, die eine Zaehlung liefert, solange die Runde offen
ist. `cast()` gibt nur zurueck, ob der eigene Stimmzettel angenommen wurde — nichts ueber
andere. `snapshot()` liefert `tally: null` und `participantCount: null`, bis `reveal()` lief.
Das ist keine Client-seitige Ausblendung, die ein neugieriger Client umgehen koennte, sondern
eine Typ- und Methodengrenze auf dem Server: es gibt keinen Aufruf, der die Zahl vorher
preisgeben wuerde.

**Ballot-Semantik: Ersetzen, nicht Umschalten.** Ein Stimmzettel ersetzt die komplette
Auswahl der abstimmenden Person (`votesByVoterId.set(voterId, neueMenge)`), statt einzelne
Optionen umzuschalten. Ein Toggle waere **nicht** replay-sicher — dieselbe Nachricht zweimal
gesendet wuerde die Stimme zweimal umschalten und damit aufheben. Ein Ersetzen ist bei
Wiederholung ein echtes No-op, was genau das ist, was "Doppel-/Replay-Stimmen sind
idempotent" verlangt.

**Wer abstimmen darf.** Sichtrecht genuegt (`canViewDrawing`), nicht Editierrecht — Abstimmen
ist Publikumshandlung, keine Autorenhandlung. Wer eine Runde **oeffnet, aufloest oder
schliesst**, braucht Editierrecht, denselben Massstab wie beim geteilten Workshop-Timer
(`socketWorkshopTimer.ts`) — bewusst **nicht** an "ist gerade Presenter" gekoppelt: Voting und
Praesentieren sind zwei unabhaengige Werkzeuge, die zusammen benutzt werden, nicht eines, das
das andere voraussetzt.

**Eine Stimme pro Verbindung, nicht pro Mensch.** Zwei Tabs derselben Person koennten zweimal
abstimmen. Bewusste Grenze, keine Uebersicht: eine Deduplizierung pro Konto haette Gaeste
(kein Konto) anders behandeln muessen als angemeldete Personen und damit eine neue,
ungeprüfte Rechteflaeche eroeffnet, fuer eine Garantie ("eine Stimme pro Mensch"), die das
Ticket nicht explizit verlangt ("Doppel-/Replay-Stimmen sind idempotent" meint Wiederholung
derselben Verbindung, nicht Identitaet ueber Verbindungen hinweg).

**Reconnect.** Eine neu verbundene Person bekommt beim Raumbeitritt den aktuellen
`VotingSnapshot` (offen ohne Zaehlung, oder aufgeloest mit Ergebnis) — dieselbe
Push-bei-Beitritt-Konvention wie der Workshop-Timer. Eine abstimmende Person, die reconnectet,
bekommt eine neue Socket-Id (siehe `COLLABORATION_NAVIGATION.md`s "Wer ist beim Reconnect noch
Follower?") und kann ihre alte Stimme nicht mehr aendern — die alte Stimme bleibt anonym in
der Zaehlung stehen. Bewusster Nicht-Ziel-Fall, symmetrisch zur Reconnect-Grenze bei Follow.

## Workshop-Templates (NIL-360)

Ein Template fuegt normale Frame- und Text-Elemente ein — ueber `buildElements`
(`integrations/excalidraw/elements.ts`) und die bereits belegte
`insert`-SceneOp-Konvention aus `documentDrop.ts`s `asWidgetElement` (Kommentar dort erklaert,
warum: der volle, von Excalidraw selbst gebaute Elementsatz muss durch, sonst fehlt der
Kollaborations-Merge-Buchhaltung genau das, was sie zum Entscheiden braucht). Keine neue
Adapterfaehigkeit noetig: die Faehigkeit, ein Frame einzufuegen, existierte schon strukturell
(Skeleton-Konverter kennt `type: "frame"`), es fehlte nur ein Aufrufer aus Produktcode.

**"Templateimport ist idempotent"** — gelesen als: ein zweiter Lauf ist unbedenklich zu
wiederholen, nicht dass ein zweiter Lauf gegen den ersten dedupliziert wird. Jeder Lauf fuegt
frisch generierte Ids ein (`nextTemplateId`, Zeitstempel + Zaehler) und kollidiert nie mit
etwas bereits Vorhandenem — eine rein additive Operation ist bei Wiederholung per Definition
unbedenklich.

Zwei Templates in dieser Version (Brainstorming, Retrospective) — bewusst wenige, wie das
Ticket verlangt ("erste wenige kuratierte Templates"). Datenstruktur (`WorkshopTemplate`,
`FrameStep[]`) ist so einfach gehalten, dass eine spaetere Team-Library (M5) sie direkt
uebernehmen kann, ohne dass dieses Paket eine Bibliotheks-Anbindung vorgreifen musste.

## Was dieses Paket nicht baut

- Kein zweiter Presence-/Timer-Begriff (siehe oben; der geteilte Timer aus NIL-376/NIL-222
  wird unveraendert wiederverwendet).
- Kein Vorbereiten von Presenter Notes ausserhalb einer laufenden Praesentation.
- Keine kontenbasierte Ein-Stimme-pro-Mensch-Garantie fuer Voting.
- Kein Frame-Umbenennen aus dem Navigator heraus.
- Keine eigene Team-Library-Anbindung fuer Templates (M5-Vertrag, absichtlich offen gelassen).
- Kein moderierter Assistent, der Timer/Frame/Voting als geskriptete Schritt-fuer-Schritt-Abfolge
  fuehrt — die drei Werkzeuge sind nebeneinander verfuegbar und ueber ein Template vorbelegt,
  aber es gibt keine erzwungene Reihenfolge. Wenn das als Luecke empfunden wird: als Kommentar
  am Paket-Ticket vermerken, nicht in dieses Paket nachtraeglich hineinbauen.
