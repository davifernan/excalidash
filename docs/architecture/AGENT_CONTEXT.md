# Agent Context: Verträge und Freigabe-Gates

Status: verbindliche Vertragsgrundlage für 0.15; Board-Mount-Grundlage in NIL-671.
Quelle: Planungsrunde 28./29.08.2026, NIL-669 und NIL-670. Stand: `main` bei
`8761b253`.

Ein Agent Context macht einen abgegrenzten Teil eines Boards zum Arbeitsmaterial eines
Agenten. Dieses Dokument legt die Grenzen vor dem ersten Produktcode fest. Es ersetzt weder
eine Autorisierungsprüfung noch eine Laufzeit-Sandbox.

## Unbewiesene Kernthese

> Ein Board ist ein besserer Kontext-Container als eine Markdown-Datei.

Das ist eine Wette, keine festgestellte Produkteigenschaft. Sie gilt erst dann als gestützt,
wenn Gate 2 zeigt, dass ein Mensch bei mehreren parallelen Agenten zuverlässig deren aktuelle
Arbeit zuordnen kann, und Gate 3 zeigt, dass der Board-Faden gegenüber einem Terminal daneben
einen beobachtbaren Vorteil liefert. Wenn eines dieser Kriterien scheitert, wird das Epic
angehalten statt das Ergebnis nachträglich umzudeuten.

### Gemessener Ausgangspunkt

Das Repo besitzt auf diesem Stand noch keinen Agent Context, keinen Runtime-Adapter und keinen
Vergleich Board gegen Markdown oder Terminal. Es gibt daher **keinen** Produktbeleg für die
Kernthese. Dass beim Betrieb von sieben Agenten eine `roster.tsv` nötig war und dass ein Nutzer
Namen nicht mehr ihren Prompts zuordnen konnte, belegt ein Adressierungsproblem. Es belegt nicht,
dass ein Board dieses Problem besser löst. Genau diese Lücke messen Gate 2 und Gate 3.

Technisch existieren nur Ausgangspunkte: zwei `/drawings/:id/agent/*`-Lesewege lesen bei jedem
Aufruf die aktuelle mutable `Drawing`-Zeile
([`drawingAgentRoutes.ts`](../../backend/src/routes/dashboard/drawingAgentRoutes.ts#L67-L119)).
Lokale Szenenänderungen werden nach **1 Sekunde Ruhe** gespeichert
([`useEditorPersistence.ts`](../../frontend/src/pages/editor/useEditorPersistence.ts#L436-L442)).
`Drawing.version` kann deshalb in einem mehrminütigen Run häufig wechseln. Es ist ein
Quell-Wasserzeichen, aber kein Run-Mount.

## Die vier Verträge

### V1 — Board-Mount

Eine unveränderliche Board-Revision wird dem Agenten read-only gemountet. Er bekommt keinen
Dump, sondern Werkzeuge, um sie selbst zu erforschen. Das Snapshot-Schema bleibt interner
Zustand und Auditgrundlage; die Explorations-API ist die Übergabeform.

Der vorhandene Editor-Vertrag trennt bereits die vollständige Szene von ihrer Leseprojektion:
`SceneCapability.readDocument()` ist lossless, während `summaries()` Geometrie, Frames, Links
und `customData` projiziert ([`capabilities.ts`](../../frontend/src/integrations/excalidraw/capabilities.ts#L51-L60)).
Der serverseitige Agent-Lesepfad liest dagegen heute bei jedem Request die mutable
`Drawing`-Zeile ([`drawingAgentRoutes.ts`](../../backend/src/routes/dashboard/drawingAgentRoutes.ts#L67-L119)).
Er ist deshalb eine Grundlage, aber noch kein Mount.

Ein Mount ist mindestens an `{ runId, drawingId, revisionId, allowedContextIds, capabilities }`
gebunden. `Drawing.version` darf die Quellversion markieren, aber nicht die unveränderliche
Run-Revision ersetzen: `DrawingSnapshot` speichert nur den Zustand vor einem Update und besitzt
weder einen Run-Pin noch einen Akteur ([`schema.prisma`](../../backend/prisma/schema.prisma#L97-L174)).

### V2 — Pinning pro Run, nicht pro Werkzeugaufruf

**Pinning erfolgt pro Run, nicht pro Werkzeugaufruf.** Sonst könnte der Agent Frame A aus
Revision 17 und dessen Ziel aus Revision 18 lesen und unbemerkt einen Zustand zusammensetzen,
der nie existiert hat.

Jede Exploration antwortet mit derselben `revisionId` und einem Result-Hash; `render()` trägt
zusätzlich Renderer-Version und Asset-Hashes. Während das Board weiter geändert werden darf,
meldet `board.changed` nur eine neue Revisionsnummer und eine bereichsbegrenzte grobe
Zusammenfassung. Neue Inhalte werden nicht in den laufenden Mount eingeblendet. Automatisches
Driften und `board.adoptRevision()` sind nicht Teil von 0.15.

### V3 — Räumliche Nähe erzeugt niemals eine maschinenwirksame Abhängigkeit

Räumliche Nähe erzeugt niemals eine maschinenwirksame Abhängigkeit. Ein untypisierter Pfeil
bleibt `semantics.kind = "unspecified"`. Der Agent darf Bedeutung vermuten und beschreiben,
aber keine operative Route daraus ableiten. Nur explizit gesetzte Semantik und explizite
Referenzen sind maschinenwirksam.

Der Semantic-Closure-Hash bindet deshalb die kanonische semantische Projektion, nicht eine
globale Drawing- oder Elementversion. Kanonische Sortierung, Zyklusbehandlung und stabile
Serialisierung sind Teil dieses Hashvertrags. Geometrie oder bloße Nähe dürfen ihn nicht mit
einer maschinenwirksamen Kante anreichern.

Das ist im Repo keine rein theoretische Vorsicht. `ambientTree` kann bei Verzweigungen,
Zusammenführungen und Zyklen sichere Negativentscheidungen treffen, hält aber ausdrücklich fest,
dass eine einfache Kette `A → B` graphisch nicht verrät, ob „fließt zu“ oder „ist Kind von“
gemeint ist ([`ambientTree.ts`](../../frontend/src/ambientTree/ambientTree.ts#L12-L56)). Die
bestehende Heuristik begrenzt eine UI-Wirkung; sie darf nicht zur Autorität für Agent-Semantik
aufgewertet werden.

### V4 — Delegation kann Rechte niemals erweitern

Jeder Subagent erhält die Schnittmenge aus: Rechten des Menschen ∩ genehmigtem Dispatch ∩
Context-Policy ∩ Runtime-Policy. Und getrennt davon: `agent:run` bedeutet nicht `board:write`.
Ein Agent kann arbeiten und Ergebnisse zur Freigabe vorlegen, ohne sie selbst auf den Canvas zu
schreiben.

Eine Context-Capability ist transitive Nicht-Befugnis: Element-ID, Bounds, Asset-ID, Kante oder
Referenz erweitern `allowedContextIds` nie. Jeder Resolver prüft die effektive lesbare Menge;
`render()` maskiert oder verweigert fremde Inhalte. Das ist nötig, weil das heutige
Socket-Protokoll Elemente als `unknown[]` führt ([`socketProtocol.ts`](../../backend/src/server/socketProtocol.ts#L39-L46));
eine Referenz ist damit eine Bezeichnung, kein sicherer Herkunftsnachweis.

## Grenzen der Dateisystem-Analogie

- Ein Dateiname ist eindeutig, räumliche Nähe ist es nicht.
- Ein Dateisystem hat eine klare Hierarchie, ein Board enthält mehrdeutige Geometrie.
- Ein `read()` im Terminal ist privat, ein sichtbarer Agent-Cursor ist eine **soziale Handlung**.

Der letzte Punkt ist eine Sichtbarkeits- und keine reine UI-Regel. Visibility ist serverseitige
Audience: private Focus-, Runtime- und Chat-Ereignisse dürfen fremde Sockets nie erreichen.
Clientseitiges Verstecken genügt nicht. Die bestehende Room-Weitergabe zeigt den Grund: ein
`element-update` wird an andere Sockets gesendet, ohne einen Akteur im Payload zu persistieren
([`socketCoreRoomEvents.ts`](../../backend/src/server/socketCoreRoomEvents.ts#L71-L107)).

## Context-Grenze, Closure und Lease

Die autoritative Zuordnung `contextId → frameElementId` war beim ersten Gegenlesen keinem Paket
zugeordnet. Der aktuelle Vertrag von NIL-671 weist sie deshalb ausdrücklich dem Board-Mount zu;
sie ist Teil der serverseitigen Context-Identität, nicht Eigentum des späteren Widgets. Ein
Element gehört höchstens einem Context; überlappende Context-Frames werden verboten. Ohne diese
Zuordnung kann ein Resolver weder `allowedContextIds` durchsetzen noch kann NIL-677 Agent-Frames
schützen. Dieses Dokument entscheidet nicht vorweg, wie Zuordnung, Lebenszyklus und Persistenz
implementiert werden.

Ein ausgehender Pfeil, eine Referenz oder ein Asset darf die effektive Lese-Menge nie erweitern.
Der Negativfall ist verpflichtend zu testen: Context A verweist auf nicht erlaubten Context B;
`followEdge`, `readElements`, `render` und `readAsset` dürfen B nicht offenlegen.

Ein Lease serialisiert öffentliche Wirkung, nicht Read-only-Erkundung. Beliebig viele
Read-only-Runs dürfen parallel lesen. Genau ein atomar erworbener, serverautoritativ verwalteter
Holder darf `artifact:publish`, `board:write` oder eine andere geteilte Wirkung auslösen. Der
Vertrag verlangt persistentes Compare-and-swap und Serverzeit für Acquire, Renew, Transfer und
Release. Das konkrete Persistenzmodell und die autorisierte Takeover-Regel sind in NIL-680 noch
offen; ein sichtbarer Übernahmevorgang ist für sich allein keine Autorisierung.

## Freigabe-Gates

### Gate 1 — Trägt der Board-Mount? (nach NIL-671)

Vor dem Versuch werden ein Board-Fixture, eine Frage und die richtige Antwort festgeschrieben.
Das Gate besteht nur, wenn ein echter Agent die richtige Antwort ausschließlich über die
öffentliche Explorations-API findet, das Audit keinen Dump-/Snapshot-Fallback zeigt und alle
Werkzeugantworten dieselbe `revisionId` tragen. Eine absichtliche Board-Änderung zwischen zwei
gleichen Reads darf Payload und Result-Hash des laufenden Runs nicht verändern. Jede Abweichung
ist ein Nichtbestehen; dann starten weder Schreibweg noch Presence-Pakete.

### Gate 2 — Hilft sichtbare Agent-Presence? (nach NIL-672 und NIL-673 gemeinsam)

In einem festgeschriebenen Szenario arbeiten drei Agenten gleichzeitig in drei Contexts. Das
Gate besteht nur, wenn die Testperson bei jeder Stichprobe Agent und aktuellen Context ohne
Rückfrage richtig zuordnet und ein privater Lauf auf einem fremden Socket **null** Focus-,
Runtime- oder Presence-Ereignisse erzeugt. Ein Fehler, eine Rückfrage oder ein privates Ereignis
ist ein Nichtbestehen; dann wird die Kernthese nicht als gestützt behandelt.

### Gate 3 — Ist der Board-Faden besser? (nach NIL-675 und NIL-678)

Dieselben Suchaufgaben werden mit denselben Zielinformationen einmal im Board-Faden und einmal
im Terminal daneben durchgeführt; Reihenfolge und Teilnehmer werden ausgeglichen. Vorher werden
Zeit bis zum Auffinden von Context, Laufstatus und Ergebnis sowie Fehlzuordnungen und Rückfragen
als Messgrößen festgeschrieben. Das Gate besteht nur, wenn der Board-Faden eine niedrigere
Medianzeit erreicht und weder mehr Fehlzuordnungen noch mehr Rückfragen erzeugt. Gleichstand ist
kein Bestehen. Andernfalls wird der Board-Faden nicht zur Standardoberfläche erklärt.

### Gate 4 — Rechtfertigt der Nutzen einen Terminal-Reiter? (vor NIL-681)

NIL-681 bleibt außerhalb von 0.15. Es darf erst dispatchbar werden, wenn Gate 1 bis 3 bestanden
sind und Davi eine schriftliche Go-Entscheidung zu einer Kosten-/Risikovorlage festhält. Diese
Vorlage muss mindestens Sandbox-Isolation, CPU-/RAM-/Zeit-/Speichergrenzen, Netzwerk- und
Secret-Zugriff, Sitzungslebenszyklus, Ausgabemengen und Betriebsverantwortung beziffern oder
begrenzen. Ohne diese dokumentierte Entscheidung ist das Gate nicht bestanden; semantische
Ereignisse und der externe Runtime-Adapter bleiben der Endzustand.

## Offene Punkte und Entscheidungen

### NIL-671: Wie lebt die autoritative Context-Zuordnung?

`AgentContext` ist die kanonische serverseitige Persistenz für
`contextId → {drawingId, frameElementId, pinned}`. `registerAgentContext()` ist die einzige
Schreibnaht für die Identitäts- und Überlappungsinvarianten; NIL-675 darf sie aus einer
autorisierten Route aufrufen, aber keine zweite Wahrheit im Widget schaffen. Ein
`AgentBoardRevision` friert Zuordnung und Szene gemeinsam ein, ein `AgentRunMount` bindet sie an
Run, erlaubte Contexts und Lesefähigkeiten. Der ausführbare Vertrag steht in
[`AGENT_BOARD_MOUNT.md`](AGENT_BOARD_MOUNT.md).

### NIL-676: Wie wird die Semantic Closure kanonisiert?

`backend/src/agent/instructionClosure.ts` definiert Closure-Schema 1. Der Hash bindet nur
serverseitig materialisierte, typisierte Bedeutung: den NFC- und newline-normalisierten
`originalText` der Anweisung, explizite `depends_on`-/`references`-/`whole_frame`-/`group`-
Relationen und deren transitive, innerhalb desselben Context liegende Ziele. Kanonische
Sortierung, Deduplizierung und Zyklusbehandlung machen die Projektion stabil; Geometrie, Stil,
Index, untypisierte Pfeile und benachbarter Inhalt sind ausdrücklich kein Hash-Eingang.

Eine Freigabe ist an den `closureHash` einer serverseitigen Vorschau gebunden. Der Client muss
denselben Hash beim zweiten, sichtbaren Klick **„Diese Fassung freigeben“** vorlegen; jede
Text- oder Closure-Änderung dazwischen endet mit `APPROVAL_PREVIEW_STALE`. Eine bestehende
Freigabe wird beim Dispatch-Seam gegen die gepinnte Revision neu geprüft und verfällt bei jeder
Abweichung. Dieses Dokument legt weiterhin keinen Hash über globale Drawing- oder
Elementversionen als Ersatz fest.

### NIL-677: Welche menschliche Provenance trägt ein Element?

Offen. Der Server besitzt heute keine Element-Provenance: Der Socket-Handler persistiert beim
`element-update` keinen Akteur, das Protokoll enthält opake Elemente, und weder `Drawing` noch
`DrawingSnapshot` hat `actorUserId` ([`socketCoreRoomEvents.ts`](../../backend/src/server/socketCoreRoomEvents.ts#L71-L107),
[`socketProtocol.ts`](../../backend/src/server/socketProtocol.ts#L39-L46),
[`schema.prisma`](../../backend/prisma/schema.prisma#L97-L174)). Der Mensch, dessen Client den
Vollzustand speichert, ist nicht der Autor der enthaltenen Änderungen — sein Client hat vorher
Änderungen anderer Sockets eingemischt.

Optionen: Gastmutationen in registrierten Agent-Frames auf Socket- und Persistenzweg verweigern;
oder Context-lokale Contribution/Admission-Provenance einführen; oder eine ausdrückliche
Übernahme durch eine berechtigte Person verlangen. Die Wahl bestimmt den Umfang von
Defense-in-depth und die Contribution-Policy. NIL-677 hängt echt an NIL-671: Ohne
Context→Frame-Zuordnung ist die Schutzregel nicht durchsetzbar.

### NIL-680: Wie werden Lease-CAS und Übernahme umgesetzt?

Persistentes, atomares Compare-and-swap ist Pflicht, seine Datenform aber noch nicht entschieden.
Auch die Takeover-Regel ist offen; sie ist eine soziale Entscheidung für ein geteiltes Board.
Optionen sind Zustimmung des Holders, ein ausdrücklich privilegierter Override oder
ausschließlich Warten/Übergabe-Anfrage. Davon hängen Lease-Transfer, Audit-Ereignisse und die
Nutzererwartung an sichtbare Übernahme ab. Eine stillschweigende Übernahme ist in keinem Fall
zulässig.

### NIL-683: Für wen wird die Runtime gebaut?

Offen: nur für selbstgehosteten, co-lokalen Einzelbetrieb oder für mehrere Menschen mit eigenen
Laptops. Herdrs Socket ist owner-only (`0600`); ein zentraler Server kann nicht auf fremde
`localhost`s zugreifen. Der Einzelbetrieb kann eine lokale Runtime voraussetzen. Mehrbenutzer
braucht einen ausdrücklich gebauten Transport (co-lokale Runtime, SSH oder authentifizierte
Outbound-Bridge/Pairing), die Zuordnung Runtime→zahlender Nutzer und eine Auswahl vor Dispatch.
Diese Entscheidung verschiebt Umfang, Transport- und Sicherheitsmodell erheblich.

NIL-673 hält beide Antworten technisch offen: Der runtime-neutrale Connection-Vertrag kennt
installationsweite und nutzergebundene Audiences; nur der erste konkrete, ausdrücklich
co-lokale Herdr-Transport benutzt einen Unix-Socket. Er trifft keine Deployment-Entscheidung
für NIL-683. Details und Sicherheitsgrenze stehen in
[`AGENT_RUNTIME_ADAPTER.md`](AGENT_RUNTIME_ADAPTER.md).

### NIL-682: Lizenzentscheidung vor Runtime-Portierung

Die Übernahme von `origin/alpha:backend/src/ai/**` hängt vom möglichen AGPL-Wechsel ab. NIL-682
ist Davis Entscheidung und kein Auftrag aus diesem Dokument. Bis sie gefallen und im Repo
umgesetzt ist, darf NIL-683 keinen AGPL-Code in den derzeitigen Fork übernehmen. Unabhängig
davon bleibt Alphas AI-Pfad nur eine Portierungsreferenz: sein Context-Dump und unmittelbarer
Schreibweg widersprechen V1, V2 und der Freigabegrenze.

## Nicht-Ziele dieser Grundlage

Dieses Dokument liefert keinen Produktcode, kein Prisma-Schema, keine React-Komponente, keinen
Agent-Schreibweg und keine Sandbox. Der Terminal-Reiter bleibt zuletzt und außerhalb von 0.15,
bis Gate 4 bestanden ist.
