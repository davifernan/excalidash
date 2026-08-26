# Collaboration Navigation: Follow, Invite Here, Presence

Status: verbindlicher Produktvertrag fuer NIL-372
Arbeitsstand: 2026-08-23
Betroffene Verträge: `frontend/src/pages/editor/followMode.ts`, `inviteHere.ts`,
`socketCollaborators.ts`, `useEditorCollaboration.ts`,
`backend/src/server/{socketFollow,socketPresence,socketInviteHere,presenceRegistry}.ts`

## Verbindungszustand: nur der Stoerfall zeichnet Chrome

Eine gesunde, beigetretene Socket-Verbindung erzeugt kein Status-Element. Der fruehere gruene
"Connected"-Punkt war fast immer sichtbar und trug deshalb keine handlungsrelevante Information.
Die Zustandsquelle in `useEditorCollaboration.ts` bleibt unveraendert; nur ihre Darstellung in
`ConnectionStatusBadge.tsx` folgt jetzt diesen Regeln:

- `connected`: kein Rahmen, kein Badge und kein entsprechendes DOM-Element.
- `offline`: ein durchgehender roter 1-px-Rahmen um den gesamten Editor mit dem unten
  angesetzten Badge **Disconnected**.
- `reconnecting`: derselbe Rahmen mit **Reconnecting**, dessen Punkte sichtbar
  `.` → `..` → `...` → `.` durchlaufen. Nach dem echten Room-Rejoin verschwindet der
  gesamte Zustand wieder.

Rahmen und Badge sind ausdruecklich `pointer-events: none`; sie duerfen weder Canvas noch Chrome
an irgendeiner Viewport-Kante aus dem Hit-Testing verdraengen. Die durchgehende rote Rechteckform
mit Text bezeichnet den Zustand der gesamten Verbindung. Damit ist sie absichtlich nicht mit
NIL-590s kleinen, einzelnen Dreieckspfeilen in Kollaboratorfarbe zu verwechseln, die eine Person
und eine Richtung am Rand bezeichnen. Der Rahmen belegt deshalb NIL-607s semantische Rolle
`element-content`; die Praesenzpfeile liegen auf `element-overlay` und bleiben auch dort sichtbar,
wo ein Pfeil das undurchsichtige Badge ueberlappt.

## Warum dieses Dokument existiert

Davis Beschwerde ("die Folgen-Funktion tut nichts") und die Anschlussbeobachtung ("dieser
Rahmen-Effekt ist weg") waren am Ende dasselbe Symptom aus zwei Blickwinkeln: Folgen brach in
dem Moment ab, in dem man es benutzte, weil eine inaktive Browser-Tab-Kachel wie ein echter
Abgang behandelt wurde. Fünf Reparaturrunden trafen dieses Symptom, bevor die Ursache benannt
war. Dieses Dokument legt die Begriffe fest, damit eine sechste Runde nicht wieder bei "was
heisst folgen eigentlich" anfaengt.

## Zwei Einstiege, ein Folge-Vertrag

### Follow ("Follow me") — dauerhaft

- Startet, wenn jemand den Avatar eines Kollaborators anklickt (Excalidraws eigene
  `onUserFollow`-UI), eine Einladung zu dessen Sicht annimmt oder ueber die sichtbare
  Follow-Anzeige erneut ausgeloest wird.
- Haelt an, bis eines von vieren eintritt:
  1. Die folgende Person klickt die sichtbare Abbruchmoeglichkeit — Excalidraws eigenen
     Trennen-Knopf im Follow-Badge (`.follow-mode__disconnect-btn`) — oder klickt den Avatar
     erneut; beides loest denselben `follow-user UNFOLLOW` aus (Details unten unter
     "Follow-Anzeige und Abbruchmöglichkeit").
  2. Die verfolgte Person **trennt die Verbindung wirklich** (Server-Disconnect, nicht Tab-
     Wechsel) — die Folge-Beziehung endet mit einer expliziten Meldung
     (`getFollowInterruptionMessage("disconnected")`).
  3. Der Zugriff der verfolgten Person auf das Board wird entzogen (`access-revoked`).
  4. Ein Zyklus wuerde entstehen (`cycle-detected`, siehe unten) oder das Rate-Limit greift.
- **Ueberlebt Tab-Inaktivitaet der verfolgten Person.** Das ist die Kernkorrektur dieses
  Pakets: `isActive: false` ist ein Fokusverlust des Browsers, kein Verbindungsende, und darf
  die Folge-Beziehung nicht beenden.
- **Ueberlebt eine kurze eigene Netzwerkunterbrechung** der folgenden Person
  (`socketRoomLifecycle.ts`'s `rememberedTarget`, bereits vorhanden): das Ziel wird nach dem
  Wiederverbinden automatisch neu angefordert.
- Bewegt fortlaufend den Viewport der folgenden Person, solange sie folgt (blauer Rahmen,
  `createViewportIndicator` in `followMode.ts`).

### Invite Here — Einladung in denselben Follow-Modus

- Startet, wenn jemand **Invite everyone here** ausloest: ein Broadcast an alle im Raum mit
  der eigenen aktuellen Sicht.
- Jede empfangende Person **akzeptiert oder lehnt individuell ab**, innerhalb von 15 Sekunden.
- Ein Accept richtet den Viewport zuerst einmal auf die eingeladene Sicht aus
  (`viewport.showBounds`) und startet danach ueber `bindFollowMode.follow()` denselben
  `collaboration.follow()`-Zustand wie ein Avatar-Klick. Es gibt keinen zweiten Transport-
  oder Viewport-Mechanismus fuer Einladungen.
- Ist die eigene Sicht bereits nahe an der eingeladenen (Overlap ≥ 85 %, `isAlreadyThere` in
  `inviteHere.ts`), wird der anfaengliche Sprung ausgelassen — Feedback statt Bewegung
  ("You're already looking at this area."). Folgen startet trotzdem und der Accept zaehlt
  fuer den Einladenden.
- Eine spaeter angenommene Einladung ersetzt das bisherige Follow-Ziel, genau wie der Wechsel
  per Avatar. Beendet wird ueber Excalidraws sichtbaren Follow-Badge oder durch eine eigene
  Kamerabewegung der folgenden Person (siehe unten).

### Warum daraus kein zweiter Follow-Modus entsteht

Invite Here besitzt weiterhin nur den zeitlich begrenzten Countdown-Banner und den anfaenglichen
Viewport-Fit. Nach dem Accept setzt `bindFollowMode.follow()` ueber den Excalidraw-Adapter
`userToFollow`; Excalidraws vorhandener `onUserFollow`-Callback laeuft danach durch exakt den
Intent-, Server-, Viewport- und Abbruchpfad des Avatar-Klicks. Sichtbar ist deshalb ebenfalls
Excalidraws eigener `FollowMode`-Badge (naechster Abschnitt), kein Invite-spezifischer
Folgezustand.

## Follow-Anzeige und Abbruchmöglichkeit: nicht neu gebaut

Das Ticket verlangt einen sichtbaren "Ich folge {Name}"-Zustand mit Abbruchmöglichkeit.
Excalidraw bringt das bereits mit: `components/FollowMode/FollowMode.tsx` rendert
unbedingt, sobald `appState.userToFollow` gesetzt ist — ein Badge mit Namen und einem
Trennen-Knopf, der über den bestehenden `onUserFollow`-Callback exakt denselben
`follow-user UNFOLLOW`-Pfad ausloest wie ein erneuter Avatar-Klick
(`onUserFollowEmitter.trigger` in Excalidraws `componentDidUpdate`, ausgeloest von jeder
Aenderung an `userToFollow`, nicht nur einem Klick). Ein eigenes Overlay dafuer haette das
Badge dupliziert, nicht ergaenzt — verworfen, nachdem ein erster Entwurf genau das tat und
im E2E-Test sichtbar redundant war. `e2e/tests/follow-mode.spec.ts` haengt sein
Sichtbarkeits- und Abbruch-Nachweis deshalb an `.follow-mode__badge` /
`.follow-mode__disconnect-btn`, nicht an eigenem Markup.

## Bekannte Lücke: Follow per Avatar lässt sich auf Mobile nicht starten

Gemessen mit einem 390×844-Viewport: Excalidraws eigene Kollaborator-Avatare
(`.UserList__collaborator`) rendern auf Mobile **gar nicht** — dieselbe
`layer-ui__wrapper__top-right`-Region, die `EditorTopRight.tsx` dort bereits leer lässt
(siehe `chromeSlots.tsx`s Dateikopf), verschwindet komplett, nicht nur unser eigener Teil
davon. Ein Avatar-Klick kann Follow auf Mobile daher weiterhin nicht starten. Eine empfangene
Invite-Here-Einladung kann es nach einem ausdruecklichen Accept inzwischen sehr wohl; sie ist
aber kein jederzeit verfuegbarer Ersatz fuer eine Peer-Auswahl.

Nicht in diesem Paket geschlossen: Ein MainMenu-Eintrag pro Peer ("Follow {Name}") würde
`collaboration.follow(presenceId)` direkt aufrufen müssen (Excalidraws eigener Watcher
sendet die Server-Anfrage dann automatisch, siehe oben) und bräuchte dafür entweder die
Collaboration-Capability oder einen neuen Trigger-Callback auf `ChromeSlotContext` — beides
verlangt eine Erweiterung von `EditorView.tsx`, die für dieses Paket ausdrücklich
ausgeschlossen war. Als benannte Lücke gemeldet statt still übergangen; guter Kandidat für
einen eigenen, kleinen Slice, sobald `EditorView.tsx` wieder offen ist.

## Zwei Personen folgen einander gegenseitig

Bereits vom Server abgefangen (`wouldCreateCycle` in `socketFollow.ts`, vor diesem Paket
vorhanden): folgt A bereits B, kann B nicht gleichzeitig A folgen — der Versuch wird mit
`cycle-detected` abgelehnt. Dieses Paket macht die Meldung dafuer lesbar ("You can't follow
someone who is already following you.") statt der bisherigen generischen Fallback-Meldung.

## Inaktivitaet vs. echter Disconnect

Zwei sichtbar unterschiedliche Zustaende, nicht einer:

| Zustand          | Ausloeser                                  | Sichtbar als                                                          | Folgen-Wirkung                      |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------- |
| Aktiv            | Tab im Fokus                               | normaler Avatar/Cursor                                                | folgt normal                        |
| Inaktiv ("away") | Tab-Blur/Fenster verlassen, laenger als 4s | Name traegt `· away`-Suffix, Cursor bleibt an letzter Position stehen | Folgen laeuft unveraendert weiter   |
| Getrennt         | echter Socket-Disconnect                   | verschwindet vollstaendig aus der Teilnehmerkarte                     | Folgen endet mit expliziter Meldung |

Die 4-Sekunden-Verzoegerung ist eine reine Frontend-Massnahme (`socketCollaborators.ts`,
`AWAY_GRACE_MS`) gegen Flackern bei einem kurzen Alt-Tab; sie ist keine serverseitige Frist,
weil `presenceRegistry.ts` inaktive Eintraege bereits unbegrenzt haelt (`setActive` loescht nie,
nur `leave` tut das) und ein echter Disconnect ohnehin durch Socket.IOs eigenes
Ping-Timeout begrenzt ist. Eine zusaetzliche serverseitige Verfalls-Uhr wuerde eine zweite
Quelle der Wahrheit fuer dieselbe Frage einfuehren, ohne ein beobachtetes Problem zu loesen —
absichtlich nicht gebaut.

## Wer ist beim Reconnect noch Follower?

- **Die eigene** kurze Verbindungsunterbrechung: das Folge-Ziel wird gemerkt und nach dem
  Wiederverbinden automatisch neu anfordert (`rememberedTarget`, unveraendert durch dieses
  Paket).
- **Die verfolgte Person** reconnectet mit einer neuen Socket-Verbindung (neue `presenceId`):
  keine automatische Wiederherstellung. Ein echter Disconnect hat die Beziehung bereits sauber
  beendet (siehe Tabelle oben); die neue Verbindung ist eine neue Person aus Sicht des
  Follow-Protokolls, kein automatisches Wieder-Folgen.
- Wer jemanden **folgte**, bevor diese Person das Board verliess, bekommt beim Verlassen die
  explizite "disconnected"-Meldung und muss danach aktiv neu folgen.

## Glatter Cursor (NIL-373, Punkt 3 von 3)

Ein aktiver Cursor bewegt sich jetzt zwischen zwei empfangenen Positionen, statt zwischen
ihnen zu springen. `cursor-move`-Events kommen mit maximal ~20/s an (der Sender drosselt auf
minimal 50ms Abstand, `lastCursorEmit` in `useEditorCollaboration.ts`); `socketCollaborators.ts`
interpoliert jede neue Zielposition ueber ein 50ms-Fenster (`CURSOR_INTERP_MS`), gezeichnet mit
`requestAnimationFrame` bei jedem Frame, bis das Ziel erreicht ist.

Das bricht die dokumentierte "laeuft nur, waehrend es etwas zu zeichnen gibt"-Optimierung nicht:
eine laufende Interpolation IST etwas zu zeichnen. Der Loop startet bei einer `cursor-move` und
stoppt wieder, sobald jeder verfolgte Cursor sein Ziel erreicht hat — bei einem still stehenden
Cursor wird kein einziger Frame mehr angefordert. Eine dritte Position, die eintrifft, bevor die
vorherige Interpolation fertig ist, setzt bei der tatsaechlichen aktuellen Zwischenposition an
(nicht beim zuletzt gesendeten Ziel), damit ein schnell bewegter Cursor nicht sichtbar
zurueckspringt.

Reine Client-Arbeit wie im Ticket verlangt: keine neuen Events, keine zusaetzliche Netzlast — die
Interpolation rechnet ausschliesslich mit Positionen, die ohnehin schon eintreffen.

## Wire-Validierung und Missbrauchsschutz

Die urspruengliche Planung dafuer stand in `docs/follow-mode.md` (vor der M6-Konsistenzpruefung
geloescht, da veraltet und teils falsch); die Invarianten selbst sind laengst umgesetzt und in
`backend/src/server/socket.test.ts` durchgesetzt, nicht nur beschrieben: Feld-Whitelist fuer
`cursor-move` und Element-Relay (`"whitelists cursor and element relay fields"`), nur endliche
Viewport-Werte an einen registrierten Follower geroutet
(`"routes finite viewport bounds only to a registered follower"`), Drosselung ueber
`SELECTION_LIMITS`/`CURSOR_CHAT_LIMITS` (`socketSelection.ts`/`socketCursorChat.ts`), und beide
Richtungen einer Follow-Beziehung werden bei fehlgeschlagener Rechtepruefung aufgeraeumt. Ein
Test, der umfallen kann, ist der verbindliche Vertrag hier — dieser Abschnitt ist nur der
Wegweiser dorthin.

## Bewusst nicht gebaut in diesem Paket

- Eine eigene serverseitige Inaktivitaets-Verfallsuhr (siehe oben).

## Was M4 (NIL-357, Presenter/Audience) uebernehmen kann

- "Folgen" ist ein Eins-zu-eins-`userToFollow`-Zeiger, kein Broadcast-Modus. Ein
  Presenter-Vertrag braucht einen eigenen serverseitigen Zustand ("wer ist gerade Presenter"),
  nicht N parallele `follow-user`-Kommandos.
- Die Inaktiv/Disconnect-Unterscheidung aus diesem Dokument gilt unveraendert: ein Zuschauer
  mit inaktivem Tab ist noch Publikum, ein wirklich getrennter Zuschauer nicht.
- `viewport.showBounds`/`subscribeScroll` (M1-Adaptervertrag) sind der Mechanismus, den ein
  Presenter-Broadcast wiederverwenden kann; `wouldCreateCycle`s Zyklus-Schutz ist bei einem
  Ein-Presenter-Modell nicht mehr relevant, weil dort nur eine Richtung existiert.
