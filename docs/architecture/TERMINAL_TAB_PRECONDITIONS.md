# Terminal-Reiter: Voraussetzungen und offene Fragen

Status: begründete Ablehnung für 0.15, keine Bauabsicht. Quelle: NIL-681, Planungsrunde
28./29.08.2026, Recon vom 29.08.2026 (Herdr-Laufzeit, V4-Mechanismus, Lease-Modell). Dieses
Dokument hält fest, was gelten müsste, damit die Entscheidung eines Tages überdacht werden
kann — es ist keine Bauanleitung und kein Aufruf, damit anzufangen.

## Was er tun sollte

Ein Reiter neben Chat, Artefakten und Kontext, der eine laufende Agenten-Terminalsitzung
zeigt: wer zusieht (`terminal:read`), wer eingibt (`terminal:input`), mit sichtbarer,
ausdrücklicher Übernahme statt stiller Kontrollwechsel. Primär dargestellt würden semantische
Ereignisse (Plan erstellt, Datei geändert, Test fehlgeschlagen, Rückfrage, Artefakt
veröffentlicht), das Rohterminal nur als bedarfsgesteuerte Detailansicht — sonst wandert nur
der Scroll-Puffer vom Terminal-Fenster ins Board, ohne das Adressierungsproblem zu lösen, das
dieses Epic eigentlich angeht.

## Warum nicht in 0.15

ExcaliDash ist heute ein Whiteboard-Server: jede Wirkung ist ein einzelner, servergeprüfter
Aufruf (ein `board:write`, ein `artifact:publish`). Ein Terminal-Reiter mit echtem
`terminal:input` macht daraus einen Compute-Provider: einen Dienst, der fremden Code auf
eigener Infrastruktur ausführt, mit allem, was das an Missbrauchsabwehr, Betriebslast und
Haftung dauerhaft mit sich bringt — nicht einmalig beim Bauen, sondern bei jedem neuen
Angriffsvektor erneut. Das ist ein Wechsel der Produktklasse, kein weiteres Feature, und er
beantwortet die eigentliche Epic-These (Board vs. Markdown-Datei als Kontext-Container) nicht
— er umgeht sie eher.

## Voraussetzungen

Jede einzelne muss erfüllt sein, nicht nur wünschenswert:

- **Ausführungsisolation.** Ohne einen Sandkasten, den ExcaliDash selbst kontrolliert oder
  glaubwürdig delegiert, kann ein Shell-Befehl beliebig auf Host, Netz und Dateisystem wirken.
- **Rechte am ausgeführten Code.** Der Server muss wissen, in wessen Namen und mit welcher
  Berechtigung ein Befehl läuft — sonst ist jede spätere Zurechnung nachträglich erfunden.
- **Haftung für Wirkungen des Agenten im Terminal.** Ein Betreiber trägt reale Verantwortung
  für das, was in seiner Sandbox passiert; ohne geklärte Grenze ist das ein offenes Risiko,
  kein technisches Detail.
- **Zurechenbarkeit einzelner Kommandos.** Ohne Audit-Spur pro Befehl ist im Streitfall nicht
  rekonstruierbar, was wer wann ausgelöst hat — dieselbe Anforderung, die `board:write` heute
  schon erfüllt.
- **Beendbarkeit.** Eine Sitzung, die niemand zuverlässig stoppen kann, ist ein Ressourcen- und
  Sicherheitsleck, das mit der Zeit wächst, nicht nur ein Komfortproblem.
- **Ressourcengrenzen** (CPU, RAM, Zeit, Speicher, kein Docker-Socket, eingeschränktes Netz,
  Secrets nur über einen Vermittler). Ohne sie skaliert der Betriebsaufwand mit jeder aktiven
  Sitzung unkontrolliert.

## Offen — ausdrücklich, nicht gelöst getarnt

- Rechtfertigt der nach Gate 1–3 gemessene Nutzen die verbleibenden Sicherheits-, Betriebs-
  und UX-Kosten? Nur Davi kann das entscheiden, und erst nachdem Gate 1–3 gemessen sind.
- Nur Beobachten oder auch Eingabe — und falls Eingabe: wer darf Kontrolle anfordern,
  zustimmen, übernehmen, entziehen?
- Sitzungseigentum (Person, Board, Projekt) und Verhalten bei Tab-Schluss, Reload, Reconnect,
  Ablauf, parallelen Beobachtern.
- Datenpolitik der Ausgabe: live gestreamt, begrenzt gespeichert, redigiert, nie persistiert;
  Suchbarkeit, Audit-Tiefe, Löschfristen.
- Ob eine gewählte Runtime (siehe Herdr-Beobachtung unten) ihre Sitzungsgrenzen tatsächlich so
  erzwingen kann, dass sie nie mehr Rechte gewährt als V4s Schnittmenge erlaubt — ungeprüft.

Ein Kandidat verkleinert den Umfang, löst aber keine dieser Fragen: eine externe Laufzeit wie
Herdr bringt PTY, Prozess-Lebenszyklus und getrennte Observer-/Controller-Rollen
(`terminal session observe` / `terminal session control`) bereits mit — ExcaliDash bräuchte
dann keine eigene Sandbox zu bauen, nur eine autorisierte Ansicht über den bestehenden
`AgentRuntimeAdapter`. Das reduziert die Baukosten, ersetzt aber nicht Gate 4 und keine der
Fragen oben.

## Wirkung auf die vier Verträge

- **V1 (Board-Mount) und V3 (keine maschinenwirksame Nähe) halten unverändert.** Ein Terminal
  ist kein Board-Content und berührt Mount oder Geometrie nicht.
- **V2 (Pinning pro Run) ist nicht anwendbar, nicht verletzt.** Es gibt keine Board-Revision zu
  pinnen; eine Terminalsitzung ist kontinuierliche Ausführung, kein Read gegen einen
  Snapshot.
- **V4 (Delegation erweitert nie Rechte) bräuchte eine echte Neufassung, keine Erweiterung.**
  V4 setzt Rechte durch, indem jede Wirkung ein einzelner, servergeprüfter Aufruf ist — genau
  diese Voraussetzung bricht ein laufender Prozess: `terminal:input` ist kein Aufruf mit einer
  Wirkung, sondern ein Gateway zu einer unbegrenzten Folge künftiger Aufrufe, von denen keiner
  den heutigen Resolver durchläuft. Auflösbar nur durch eine zweite, sandkasten-basierte
  Durchsetzungsebene (Rechte werden einmalig beim Start als Sandbox-Scope berechnet, danach von
  Infrastruktur statt Anwendungscode erzwungen) — das ist V4-konform, wenn der Scope aus
  derselben Schnittmenge stammt, aber eine strukturell neue Maschine, keine Zeile Zusatzcode.
- **Das Lease-Modell (NIL-680) trägt nur im eingeschränkten Fall.** Es funktioniert, weil jede
  öffentliche Wirkung heute ein diskreter Aufruf ist, den ein abgelaufenes Lease einfach
  ablehnen kann — ein bereits abgeschickter Netzwerk-Request aus einem Terminal lässt sich so
  nicht zurückholen. Solange ein Terminal-Sandkasten strikt privat bleibt (jede geteilte
  Wirkung weiterhin über `artifact:publish`), passt das Modell sauber; sobald er echten
  Netzzugriff bekommt, bricht das Versprechen "Ablauf hält öffentliche Wirkung sicher an".
