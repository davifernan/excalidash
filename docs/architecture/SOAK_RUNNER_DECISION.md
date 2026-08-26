# Team-Readiness-Soak: Runner-Entscheidung

**Entscheidung:** Einen kurzen, regelmaessigen Sechs-Kontext-Soak auf einem GitHub-gehosteten groesseren Linux-Runner mit 8 vCPU und 32 GB RAM betreiben, falls der Account die fuer groessere Runner erforderliche Organisation mit GitHub Team oder Enterprise Cloud hat. Den vollstaendigen Acht-Stunden-Zehn-Kontext-Baseline-Lauf nicht auf einen GitHub-gehosteten Runner verlegen: er ueberschreitet dessen harte Sechs-Stunden-Jobgrenze. Falls dieses volle Profil weiter gefordert ist, gehoert es auf eine dedizierte, nicht-produktive selbst gehostete Maschine oder eine temporaere VM und muss dort erst gemessen werden.

Stand dieses Dokuments: **2026-08-26 15:54 UTC**. Analysiert wurde `main` bei `c82a3ed3609dbc6ee7159217ee5332cee7c3f4a6`; die hier verwendeten Soak-Messungen selbst liefen am 2026-08-26 gegen v0.12.0 bei `3e41c2a6f18983d1be59457d6ae4afd5d2ed6458`. Deshalb sind sie Kapazitaetshinweise, nicht der Nachweis fuer den heutigen Produktstand. Eine Messung nach weiteren Soak-relevanten Aenderungen ist erneut zu datieren und gegen ihren exakten SHA auszuwerten.

## Gemessen

Die folgenden Werte sind vorhandene eigene Laeufe, keine Hochrechnung:

| Profil                                           | Ergebnis                                                           | Laufzeit / Verteilung                                 | Speicherbeobachtung                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| 6 Kontexte, Chromium + Firefox, Soll-Dauer 300 s | bestanden; keine Watchdog-Verletzung; alle sechs am Ende verbunden | `actualElapsedMs=321861`; 98 Zyklen, 15--17 je Akteur | Belegt von 4,4 auf 9,6 GB nach 90 s, danach stabil; nach Ende 11,5 GB verfuegbar  |
| 10 Kontexte, Chromium + Firefox                  | nach rund einer Stunde zum Schutz der Produktion abgebrochen       | kein valider Abschlusswert                            | 13,8 von 15,9 GB RAM belegt; 8.191 von 8.191 MB Swap belegt; rund 2 GB verfuegbar |
| 10 Kontexte, frueherer Lauf                      | fehlgeschlagen, bevor er als Kapazitaetslauf aussagekraeftig war   | 4,6 min; Firefox-Akteur in `page_switch` still        | 7.908 von 8.191 MB Swap belegt                                                    |

Quelle der ersten beiden Reihen ist der Messkommentar `01a03cf6-6d2d-7514-95f4-b608cea296f7` an NIL-330; die dritte Reihe stammt aus `01a03c9c-b2bb-7238-9d63-a49a2ad5defa`. Der spaetere, unabhaengige Fuenf-Minuten-Nachweis in PR #184 meldet ebenfalls sechs Kontexte mit 180 Zyklen, null Fehlern und null Watchdog-Verletzungen; er beschreibt aber keine mit der ersten Reihe identische Laufzeit- oder Speicherprobe und wird deshalb nicht in eine gemeinsame Kennzahl gemischt.

### Zeitgrenze

Der einzige vollstaendig instrumentierte Sechs-Kontext-Lauf dauerte 321,861 s (5 min 21,861 s), also 21,861 s Auf- und Abbau ueber der konfigurierten Fuenf-Minuten-Dauer. Das laesst sich nicht serioes zu acht Stunden extrapolieren: Langzeitverhalten, erneute Browser- oder Speicherpeaks und Queueing wurden in dieser einen Probe nicht beobachtet.

Es gibt keine Wiederholungsserie gleicher Konfiguration und gleicher SHA. Ein Mittelwert, Median, p95 oder "Luft in Prozent" waere daher erfunden. Der Median ist hier besonders ungeeignet: Die relevante Form hat mindestens zwei unterschiedliche Modi (der bestandene Sechs-Kontext-Lauf und der wegen Kapazitaetsrisiko abgebrochene Zehn-Kontext-Lauf), nicht eine symmetrische Streuung um einen zentralen Wert.

GitHub begrenzt jeden GitHub-gehosteten Job auf **sechs Stunden**. Der geschriebene Acht-Stunden-Soak kann dort daher nicht vollstaendig erfolgreich enden, auch nicht auf einem groesseren GitHub-Runner.

- [GitHub Actions limits: sechs Stunden pro GitHub-gehostetem Job](https://docs.github.com/en/actions/reference/limits)
- [GitHub Actions limits: selbst gehostete Jobs duerfen bis zu fuenf Tage laufen](https://docs.github.com/en/actions/reference/limits)

### Lokale Maschinen- und Sicherheitsmessung

Um 2026-08-26 15:54 UTC, **ohne einen neuen Soak zu starten**, zeigte der Produktionshost:

```text
CPU: 8 online processors
Mem: 15.924 GB total, 8.681 GB available
Swap: 8.191 GB total, 7.025 GB used, 1.166 GB free
```

Die Produktionscontainer liefen dabei weiter. `excalidash-backend` nutzte 172,9 MiB und `excalidash-frontend` 3,4 MiB; die momentane Containerlast ist aber **keine** Soak-Messung. Wegen des nur noch rund 1,17-GB-freien Swaps und der koexistierenden Produktion wurde kein weiterer Lauf gestartet. Die historische Zehn-Kontext-Messung zeigt, dass genau dieser Host unter dem Profil bereits den gesamten Swap ausgeschopft hat.

Die vorhandenen Daten messen keinen CPU-Peak, keine CPU-Saettigung und keinen pro-Kontext-RAM-Verbrauch. Daraus folgt keine behauptete CPU-Mindestgroesse. Sie beweisen aber eine klare RAM-Grenze: 16 GB physischer Speicher ohne isolierten Sicherheitsabstand reichen fuer zehn Kontexte auf diesem Profil nicht; 32 GB sind eine begruendete Startgroesse fuer einen dedizierten Qualifikationslauf, noch kein bestandener Beweis.

## Vergleich mit GitHub-Runnern

Das Repository ist zum Analysezeitpunkt oeffentlich. GitHub dokumentiert fuer `ubuntu-latest` in oeffentlichen Repositories 4 vCPU und 16 GB RAM; in privaten Repositories sind es 2 vCPU und 8 GB RAM. Standard-Runner fuer oeffentliche Repositories sind kostenlos, aber sowohl sie als auch groessere GitHub-Runner unterliegen der Sechs-Stunden-Grenze.

| Option                                               | CPU / RAM                                                        | Bezug zu den Messwerten                                                                                                                | Urteil                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Standard `ubuntu-latest`, oeffentlich                | 4 vCPU / 16 GB                                                   | Gleich viel RAM wie der Host, aber halb so viele CPU-Kerne; sechs Kontexte passten lokal in 9,6 GB, zehn nicht in 16 GB plus 8 GB Swap | Als dedizierter Kurzprofil-Kandidat sinnvoll, aber fuer sechs Kontexte auf 4 vCPU noch ungemessen und fuer acht Stunden ungeeignet |
| Groesserer Linux-Runner, 4 vCPU                      | 4 vCPU / 16 GB                                                   | Gleiche RAM-Risikoklasse wie Standard                                                                                                  | Nicht fuer den Zehn-Kontext-Lauf empfehlen                                                                                         |
| Groesserer Linux-Runner, 8 vCPU                      | 8 vCPU / 32 GB                                                   | Doppelte RAM-Menge bei gleicher CPU-Zahl wie der Messhost                                                                              | Empfohlener Kandidat fuer einen 30--60-Minuten-Sechs-Kontext-Soak; zuerst genau dieses Profil messen                               |
| Dedizierter selbst gehosteter Runner / temporaere VM | vom Betreiber waehlen; mindestens 8 vCPU / 32 GB als Startprofil | Einzige der hier verglichenen Optionen ohne GitHubs Sechs-Stunden-Jobgrenze                                                            | Fuer das unveraenderte Acht-Stunden-/Zehn-Kontext-Profil erforderlich; Produktionshost explizit ausschliessen                      |

- [GitHub-hosted runners: Standard-Hardware fuer oeffentliche und private Repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub-hosted runners: groessere Runner sind Team-/Enterprise-Organisationen vorbehalten](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Larger runners: 4/16, 8/32 und weitere Linux-Groessen](https://docs.github.com/en/actions/reference/runners/larger-runners)

Ob der aktuelle Account einen groesseren Runner anlegen darf, wurde nicht nachgewiesen. GitHub verlangt dafuer eine Organisation mit Team oder Enterprise Cloud; diese Zugriffs- und Planvoraussetzung ist vor einer Workflow-Aenderung zu pruefen.

## Kostenrechnung

Die Rechnung verwendet die am 2026-08-26 veroeffentlichten USD-Minutenpreise und nimmt an: ein Linux-x64-Job, ein Runner, keine Paralleljobs, keine anrechenbaren Gratisminuten und 30 Naechte pro Monat. GitHub rundet jeden Job auf volle Minuten auf. Die Preise sind Hochrechnungen, keine Rechnung dieses Kontos.

| Profil                                                         |       Rate | Pro Lauf | Pro Nacht | 30 Naechte |
| -------------------------------------------------------------- | ---------: | -------: | --------: | ---------: |
| Standard `ubuntu-latest` im **oeffentlichen** Repository       |  $0,00/min |    $0,00 |     $0,00 |      $0,00 |
| 8 vCPU / 32 GB groesserer Linux-Runner, 30 min                 | $0,022/min |    $0,66 |     $0,66 |     $19,80 |
| 8 vCPU / 32 GB groesserer Linux-Runner, 60 min                 | $0,022/min |    $1,32 |     $1,32 |     $39,60 |
| 8 vCPU / 32 GB groesserer Linux-Runner, maximal zulaessige 6 h | $0,022/min |    $7,92 |     $7,92 |    $237,60 |

Der kontra-faktische Acht-Stunden-Preis fuer denselben 8-vCPU-Runner waere $10,56, ist aber **kein ausfuehrbarer GitHub-Job**, weil der Job bei sechs Stunden beendet wird. Groessere Runner sind auch fuer oeffentliche Repositories nicht kostenlos und verbrauchen keine eingeschlossenen Minuten. Der Preis einer dedizierten VM ist nicht pruefbar, weil Anbieter, Region, Laufzeitmodell und Reservierungsgrad nicht gegeben sind.

- [GitHub Actions Runner Pricing: Linux 2-core $0,006/min; groesserer Linux 8-core $0,022/min; Rundung](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing)
- [GitHub: oeffentliche Standard-Runner kostenlos; groessere Runner nicht kostenlos](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## Empfohlener Betrieb

1. **Taeglicher Fruehwarnlauf:** Wenn ein 8-vCPU-/32-GB-Runner verfuegbar ist, einmal taeglich sechs Kontexte, Chromium und Firefox, 30 Minuten. Nach mindestens drei erfolgreichen Wiederholungen am selben SHA-Profil auf 60 Minuten erhoehen. Die Rohwerte (Laufzeit, Zyklen je Akteur, Watchdog-Verletzungen, RSS/Swap/CPU-Zeit) als Artefakt ablegen und dann Median sowie p95 der gleichartigen Serie berichten.
2. **Vollprofil:** Den Acht-Stunden-/Zehn-Kontext-Lauf nur auf einem dedizierten, nicht-produktiven selbst gehosteten Host oder einer temporaeren VM starten; vorab `free -m`, CPU-Metriken und die verwendeten Ports dokumentieren. Das Ergebnis darf erst nach einem vollstaendigen Lauf die NIL-330-Luecke schliessen.
3. **Keine Scheinsicherheit:** Den Standard-Runner nicht als bestaetigte Kapazitaetsloesung dokumentieren. Er isoliert Produktion und ist kostenlos, aber seine 4 vCPU / 16 GB wurden mit dem Sechs-Kontext-Soak noch nicht gemessen und das Vollprofil kann er wegen der Zeitgrenze nicht erfuellen.

Damit ist die Empfehlung **gemischt**: ein GitHub-Runner fuer haeufige, kurze, sichere Frueherkennung und dedizierte eigene Rechenkapazitaet fuer das seltene, unveraenderte Acht-Stunden-Gate. Die Produktionsmaschine ist fuer beides kein Ziel.

## Nachtrag 2026-08-26: Vollprofil in vier Teilen auf dem Standard-Runner (NIL-639)

Die obige Empfehlung ging von einem **ungeteilten** Acht-Stunden-Lauf aus und schloss den
GitHub-gehosteten Standard-Runner dafuer allein wegen der Sechs-Stunden-Jobgrenze aus. Diese
Praemisse ist inzwischen ueberholt: Davi hat entschieden, dass der Soak nachts auf einem
GitHub-Runner laeuft, aber in **vier Teilen** zu je rund zwei Stunden statt als ein
Acht-Stunden-Lauf -- eine Festlegung, die vorher nirgends schriftlich stand und hiermit an
NIL-330 nachgetragen ist (Ausgangspunkt fuer diesen Nachtrag).

Damit aendert sich, was gemessen werden muss: nicht mehr "traegt ein Standard-Runner sechs
Kontexte 30 Minuten", sondern **"traegt ein Standard-Runner zehn Kontexte rund zwei Stunden, vier
Mal nacheinander"** -- NIL-639s eigentlicher Auftrag. Ein dedizierter Host ist fuer dieses
Vollprofil-Ersatzverfahren nicht mehr erforderlich; die Produktionsmaschine bleibt trotzdem fuer
jeden Soak-Lauf tabu.

**Wie die vier Teile zusammenhaengen, statt vier unabhaengige Stichproben zu sein:**
`.github/workflows/nightly-team-readiness-soak.yml` (vier sequentielle Jobs ueber
`.github/workflows/_soak-part.yml`) reicht die SQLite-Datenbank und das Asset-Verzeichnis von
Teil zu Teil per Artefakt weiter und laesst alle vier Teile dasselbe geteilte Board
(`SOAK_EXISTING_BOARD_ID`) bespielen. Die Szene, Kommentare und hochgeladenen Assets wachsen
dadurch ueber alle vier Teile hinweg genau wie in einem durchgehenden Lauf -- nur die
Browser-Prozesse selbst starten pro Teil neu. Was das **nicht** abdeckt: einen Leck-Effekt, der
sich erst innerhalb eines einzelnen, acht Stunden durchgehend offenen Browser-Tabs zeigt. Dafuer
bleibt der unveraenderte, manuell ausloesbare Acht-Stunden-Lauf auf einem dedizierten,
nicht-produktiven Host das richtige Werkzeug.

Ein fehlschlagender Teil bricht die Kette ab (`needs:`) und wird sofort sichtbar gemacht -- ein
Kommentar auf einem angehefteten Tracking-Issue, nicht nur ein rotes Kaestchen in der
Actions-Oberflaeche, das erst jemand finden muesste. Der Summary-Job laeuft trotzdem immer
(`if: always()`) und schreibt die Rohwerte dieses Laufs an ein dauerhaftes, anhaengendes Log auf
dem `evidence`-Branch. **Median und p95 werden erst berichtet, sobald dieses Log mindestens drei
erfolgreiche Laeufe desselben Profils (Kontextzahl, Engines, Teil-Dauer) enthaelt** -- dieselbe
Regel wie oben im Dokument, jetzt automatisiert statt nur als Text hier zu stehen.

Die konkreten Zahlen aus mindestens drei gleichartigen Laeufen dieses Profils sind zum Zeitpunkt
dieses Nachtrags noch nicht vorhanden; sie werden im Zuge von NIL-639 erhoben und hier oder am
Ticket nachgetragen, sobald sie vorliegen -- nicht vorher behauptet.
