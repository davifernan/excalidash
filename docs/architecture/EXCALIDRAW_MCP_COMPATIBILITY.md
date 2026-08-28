# Excalidraw-MCP-Kompatibilität

Stand: NIL-648. Der lokale `excalidash-mcp` unter `/home/claude/excalidraw-mcp` ist **für native
Excalidraw-Elemente kompatibel**, aber kein allgemeiner Autor für ExcaliDash-Produktobjekte.
Er pinnt wie das Frontend Excalidraw `0.18.1` (MCP `/home/claude/excalidraw-mcp/package.json:50-52`,
[Frontend `package.json:27-29`](../../frontend/package.json#L27-L29)) und bietet Board-Lesen/-Anlegen,
Zeichnen (DSL, Graph, Mermaid), Element-Änderung/-Löschung, PNG-Export sowie Historie/Wiederherstellen
an (MCP `/home/claude/excalidraw-mcp/src/index.js:381-416`, `571-663`, `680-855`, `869-1029`).
Seine Mermaid-Ausgabe besteht aus editierbaren Elementen, nicht aus Bildern
(`/home/claude/excalidraw-mcp/src/index.js:634-656`).

Der Schreibweg geht nicht am Fork vorbei: Der Provider schreibt per `PUT /drawings/:id` mit
der gelesenen Board-Version und sendet erst danach Socket-Updates
(`/home/claude/excalidraw-mcp/src/excalidash.js:387-415`,
`/home/claude/excalidraw-mcp/src/commit.js:16-43`). Das Backend verlangt
für diese Szene-Updates Edit-Zugriff und die aktuelle Version
([`drawingCreateUpdateRoutes.ts:166-245`](../../backend/src/routes/dashboard/drawingCreateUpdateRoutes.ts#L166-L245));
der Socket-Weg prüft ebenfalls Board-Zugriff und API-Key-Scope
([`socket.ts:248-305`](../../backend/src/server/socket.ts#L248-L305)). Damit ist ein MCP mit
eigenem, beschränktem API-Key oder Benutzerkonto ein zulässiger Board-Akteur, nicht ein
Authz-Bypass.

Die Grenze ist `customData`: Der MCP markiert seine normalen Elemente nur mit
`customData.source = "excalidash-mcp"` (`/home/claude/excalidraw-mcp/src/index.js:161-199`).
Das kollidiert nicht mit unserem Namespace, denn der Leser ignoriert fremde Schlüssel und der
Writer erhält sie ([`customData.ts:111-165`](../../frontend/src/integrations/excalidraw/customData.ts#L111-L165)).
Für Sticky Notes und Dokument-Widgets kennt der MCP aber keinen fachlichen Vertrag:
ExcaliDash erwartet `customData.excalidash` mit Schemaversion und Sticky-/Widget-Daten
([`customData.ts:12-21`](../../frontend/src/integrations/excalidraw/customData.ts#L12-L21)).
Sein generisches `update_element` akzeptiert dagegen beliebiges `customData`
(`/home/claude/excalidraw-mcp/src/elementProps.js:32-61`), das der
Transport als freies Record annimmt ([`security.ts:300-323`](../../backend/src/security.ts#L300-L323)).
**Entscheidung:** für Diagramme, Annotationen und andere native Elemente einsetzen; keine
Sticky-, Widget- oder sonstigen produktsemantischen Elemente über diesen MCP erzeugen oder
umschreiben. Dafür wäre ein expliziter, validierter ExcaliDash-Operationsvertrag nötig.
