# Orchestrator Thread: Board-Anker und Darstellungszustände

Status: implementierter UI-Vertrag für NIL-678. Nachrichten-Audience und `DispatchReceipt`
gehören NIL-679; Lease-CAS und öffentliche Wirkung gehören NIL-680.

## Warum kein Sidebar-Faden

Der gemeinsame Faden besitzt eine echte Stelle auf dem Board: eine gewöhnliche Excalidraw-
Rectangle-Card mit `customData.excalidash.orchestratorThread`. Verschieben, gemeinsames
Speichern und Reload laufen deshalb über denselben Board-Pfad wie andere Elemente. Das
`customData` enthält nur `{ threadId, title }`; Rechte, Context, Dispatch und Lease werden dort
nie gespeichert.

Die Vollansicht ist dagegen lokaler Ansichtsstatus. Die Kamera eines Menschen darf nicht die
Ansicht aller anderen verändern. Genau eine `activeThreadId` pro Editorinstanz erzwingt, dass
höchstens ein vollständiges Panel offen ist.

Auf einem wirklich leeren, editierbaren Board steht vor dem ersten Faden eine ruhige,
bildschirmfeste Einladung. Sie ist kein vierter Fadenzustand: „Place thread here“ erzeugt die
erste gemeinsame Board Card an dieser Stelle und die Einladung verschwindet. Auf einem bereits
befüllten Board wird sie bewusst nicht über die Arbeit gelegt; dort bleibt der explizite
Menübefehl. Ein Prompt-Feld wird in NIL-678 nicht vorgetäuscht, weil Nachrichten-Audience erst
mit NIL-679 verbindlich wird.

## Die drei Zustände

Die Zustände sind keine drei Größen:

1. **geschlossen:** Die Board Card skaliert mit dem Canvas und bleibt am gespeicherten Ort.
2. **offen, Anker lesbar:** Das Panel bleibt in festen Screen-Pixeln neben der projizierten
   Board Card. Der Anker ist gleichzeitig sichtbar und lesbar.
3. **offen, Anker unerreichbar:** Das Panel dockt am Viewport, nennt Richtung und Entfernung
   und bietet „Jump to anchor“. „Unerreichbar“ umfasst außerhalb des Viewports, geometrisch zu
   klein zum Lesen und fehlenden Platz für das Panel.

Der Wechsel besitzt geometrische Hysterese: ein bereits verankertes Panel darf bis zu einer
kleineren Lesbarkeitsgrenze dort bleiben; ein gedocktes kehrt erst bei der größeren Grenze
zurück. Damit führt ein Zoomwert an der Grenze nicht zu Flackern. Der dritte Zustand ist die
Funktion, die eine immer gleich weit entfernte Sidebar nicht ausdrücken kann.

Das offene Panel bleibt in allen Zoomstufen in festen Bildschirmpixeln lesbar. Die geschlossene
Card bleibt dagegen absichtlich ein echtes mitskalierendes Board-Objekt. Ihr Overlay lässt
Zeigerereignisse bis auf den kleinen „Open“-Knopf zum Excalidraw-Element durch, sodass Auswahl,
Verschieben und Persistenz nicht von einer DOM-Fläche blockiert werden. Die Projektion bezieht
auch Elementrotation ein.

## Verdichtung ist ausschließlich Darstellung

Überlappende projizierte, geschlossene Cards werden in Connected Components visuell
verdichtet. Weder die gespeicherten Elemente noch ihre `threadId`s werden verschoben,
zusammengeführt oder neu gebunden. Ein Cluster besitzt genau eine Aktion:

```text
{ kind: "navigate", threadId }
```

Der Nutzer muss zuerst einen einzelnen ursprünglichen Faden auswählen. Es gibt am Cluster
keine Context-, Dispatch- oder Lease-Operation. Der Negativtest mit zwei Fäden in derselben
visuellen Komponente hält diese V3-Grenze fest.

Geschlossene Fäden außerhalb des Ausschnitts werden nicht als unsichtbare DOM-Karten oder als
Rand voller Einzelpfeile belassen. Sie werden zu höchstens einem gezählten Locator pro Richtung
verdichtet. Dessen Menü enthält weiterhin jede ursprüngliche `threadId`; auch hier ist die
einzige Wirkung die Auswahl und Navigation zu genau einem Faden. Die 20-Fäden-Fixture belegt,
dass keine Identität in der Verdichtung verloren geht.

## Sichtbare Sättigung und Backpressure

Die Kippstelle ist kein fester Fadenzähler. `computeCoordinationBackpressure()` misst den
Anteil des sichtbaren Viewports, den projizierte Thread-Anker belegen. Zwanzig kleine, getrennte
Cards dürfen lesbar bleiben; zwei sehr große Cards können die Darstellung sättigen.

Ab 35 Prozent wird die Surface-Admission `blocked`. Die UI zeigt dann dauerhaft und per
`role=status`:

> Board thread view is saturated — public coordination waits for visible room.

Read-only-Arbeit bleibt ausdrücklich möglich. NIL-678 enthält noch keine öffentliche
Dispatch- oder Lease-Aktion, die warten könnte; es definiert und zeigt deren Admission-Grenze.
NIL-680 muss diese Grenze beim Einbau öffentlicher Wirkung konsumieren. Eine künftige Aktion,
die den Zustand nur versteckt oder ignoriert, würde diesen Vertrag brechen.

## Prüfbare Nähte

- `orchestratorThreadGeometry.test.ts`: Zustandsmaschine, Hysterese, Ein-Panel-Invariante,
  semantikfreie Cluster und flächenabhängige Sättigung.
- `OrchestratorThreadOverlay.test.tsx`: geschlossene Card, ein Vollpanel, gedockter Ortshinweis,
  Cluster-Disambiguierung und sichtbare Backpressure.
- `useOrchestratorThreadFeature.test.tsx`: atomare Insert+Select-Schreiboperation, fehlendes
  Edit-Recht, leeres gegenüber befülltem Board, rotierte Projektion und Wiederentdeckung
  derselben gespeicherten Card nach Remount.
- `orchestrator-thread-anchor.spec.ts`: Browserpfad über Menü, Anchored→Docked bei Zoom,
  Autosave/Reload, Verschieben durch das Overlay und weiterhin höchstens ein Vollpanel; der Test
  erzeugt zugleich die Bildnachweise für Einladung und verankertes Panel.
