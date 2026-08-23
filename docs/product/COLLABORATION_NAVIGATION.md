# Collaboration Navigation: Follow, Invite Here, Presence

Status: verbindlicher Produktvertrag fuer NIL-372
Arbeitsstand: 2026-08-23
Betroffene Verträge: `frontend/src/pages/editor/followMode.ts`, `inviteHere.ts`,
`socketCollaborators.ts`, `useEditorCollaboration.ts`,
`backend/src/server/{socketFollow,socketPresence,socketInviteHere,presenceRegistry}.ts`

## Warum dieses Dokument existiert

Davis Beschwerde ("die Folgen-Funktion tut nichts") und die Anschlussbeobachtung ("dieser
Rahmen-Effekt ist weg") waren am Ende dasselbe Symptom aus zwei Blickwinkeln: Folgen brach in
dem Moment ab, in dem man es benutzte, weil eine inaktive Browser-Tab-Kachel wie ein echter
Abgang behandelt wurde. Fünf Reparaturrunden trafen dieses Symptom, bevor die Ursache benannt
war. Dieses Dokument legt die Begriffe fest, damit eine sechste Runde nicht wieder bei "was
heisst folgen eigentlich" anfaengt.

## Zwei Aktionen, zwei Vertraege

### Follow ("Follow me") — dauerhaft

- Startet, wenn jemand den Avatar eines Kollaborators anklickt (Excalidraws eigene
  `onUserFollow`-UI) oder ueber die sichtbare Follow-Anzeige erneut ausgeloest wird.
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

### Invite Here — einmalig

- Startet, wenn jemand **Invite everyone here** ausloest: ein Broadcast an alle im Raum mit
  der eigenen aktuellen Sicht.
- Jede empfangende Person **akzeptiert oder lehnt individuell ab**, innerhalb von 15 Sekunden.
- Ein akzeptierter Sprung ist **ein einziger Viewport-Fit** (`viewport.showBounds`). Danach
  besteht **keine** fortlaufende Beziehung — kein `userToFollow` wird je gesetzt.
  `inviteHere.test.ts`s "accepts once, fits once, and never enables follow mode" ist die
  Gegenprobe dazu, die schon vor diesem Paket bestand.
- Ist die eigene Sicht bereits nahe an der eingeladenen (Overlap ≥ 85 %, `isAlreadyThere` in
  `inviteHere.ts`), wird nicht gesprungen — Feedback statt Bewegung
  ("You're already looking at this area."). Der Accept zaehlt trotzdem fuer den
  Einladenden.

### Warum das nicht verwechselt werden kann

Beide Pfade waren im Code schon vor diesem Paket architektonisch getrennt (kein Aufruf von
`collaboration.follow()` irgendwo im Invite-Here-Pfad). Was vor diesem Paket fehlte, war die
**sichtbare** Unterscheidung: der blaue Rahmen erklaerte, wohin man gezogen wird, aber nicht,
dass man das angefordert hat oder wie man es beendet — waehrend Invite Here schon immer einen
Countdown-Banner mit Accept/Decline hatte. Diese Luecke schliesst kein neues Overlay dieses
Pakets, sondern Excalidraws eigenes, bereits vorhandenes `FollowMode`-Badge (naechster
Abschnitt) — vor diesem Paket lief es nur ins Leere, weil der Root-Cause-Bug es staendig
verschwinden liess.

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

## Bekannte Lücke: Follow lässt sich auf Mobile nicht starten

Gemessen mit einem 390×844-Viewport: Excalidraws eigene Kollaborator-Avatare
(`.UserList__collaborator`) rendern auf Mobile **gar nicht** — dieselbe
`layer-ui__wrapper__top-right`-Region, die `EditorTopRight.tsx` dort bereits leer lässt
(siehe `chromeSlots.tsx`s Dateikopf), verschwindet komplett, nicht nur unser eigener Teil
davon. Da der einzige Weg, Follow zu **starten**, heute ein Avatar-Klick ist, gibt es auf
Mobile aktuell keinen Einstiegspunkt dafür — unabhängig von diesem Paket, aber davon auch
nicht behoben.

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

| Zustand | Ausloeser | Sichtbar als | Folgen-Wirkung |
|---|---|---|---|
| Aktiv | Tab im Fokus | normaler Avatar/Cursor | folgt normal |
| Inaktiv ("away") | Tab-Blur/Fenster verlassen, laenger als 4s | Name traegt `· away`-Suffix, Cursor bleibt an letzter Position stehen | Folgen laeuft unveraendert weiter |
| Getrennt | echter Socket-Disconnect | verschwindet vollstaendig aus der Teilnehmerkarte | Folgen endet mit expliziter Meldung |

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

## Bewusst nicht gebaut in diesem Paket

- **Cursor-Interpolation ("glatter Cursor")** ueber mehrere Frames hinweg. Das bestehende
  `requestAnimationFrame`-Batching in `socketCollaborators.ts` glaettet bereits Bursts von
  `cursor-move`-Events auf einen Patch pro Frame; eine echte Positions-Interpolation zwischen
  zwei Punkten braeuchte einen kontinuierlichen Animationsloop unabhaengig von neuen Events,
  was der bestehenden, bewusst dokumentierten Optimierung "läuft nur, während es etwas zu
  zeichnen gibt" direkt widerspricht. Nicht in den Exit-Kriterien dieses Tickets gefordert;
  als Folgearbeit an NIL-357 gemeldet, falls M4 es fuer die Praesentationsansicht braucht.
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
