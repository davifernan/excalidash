# Mind Map relationship and layout contract

Status: binding architecture for NIL-569 / NIL-570

## Semantic authority

A mind map is a versioned ExcaliDash relationship layer over ordinary
Excalidraw elements. Nodes are rectangles with bound text and edges are bound
arrows. A client that knows nothing about this feature therefore still sees a
normal, editable drawing.

The semantic edge is stored exactly once, on the child node:

```ts
customData.excalidash = {
  schemaVersion: 2,
  mindMap: {
    mapId: string,
    parentId: string | null,
    orderKey: string,
  },
};
```

The root uses `parentId: null`. The visible arrow only carries the projection
marker `{ mapId, childId }` in `mindMapProjection`. It is never consulted to
infer parenthood. Free arrows remain free cross-links.

Sibling order is the total, locale-independent order `(orderKey, elementId)`.
The element ID tie-break is required because two clients may create siblings
with the same order key from the same starting state.

The relationship is an optional record in the existing current ExcaliDash
namespace schema. Existing sticky/widget elements remain schema-version 2 and
can coexist with the new record; there is no old/new read path or feature flag.

## Integrity and loss-aware failure

`frontend/src/mindMap/model.ts` validates the complete relationship layer
before any layout or structural batch is allowed. It rejects:

- duplicate element IDs
- no root or multiple roots
- a missing parent
- a parent that belongs to another map
- self-cycles and multi-node cycles

Invalid data has one named behavior: `preserve-scene`. The application does not
guess a replacement root, detach an orphan, rewrite metadata, move elements or
delete an arrow. Ordinary visible content and hand positions stay intact while
the caller can surface deterministic diagnostics. An explicit later repair can
be designed from evidence; receiving, loading or saving a malformed map is not
permission to mutate it.

## Deterministic layout

`frontend/src/mindMap/layout.ts` is the pure layout boundary. Its complete
input is:

1. a validated normalized tree with sorted children
2. fixed node size and fixed level/sibling gaps
3. the root's top-left scene anchor

Its complete output is `{ elementId, x, y }[]`. The implementation directly
uses `d3-hierarchy.tree()` (Buchheim/Reingold-Tilford) with `nodeSize`, swaps
D3's breadth/depth axes for a left-to-right tree, and keeps the root anchor
fixed. It has no access to DOM, viewport, selection, socket, clock or random
state. Equal normalized input produces bit-identical JSON coordinates.

Layout is a calculation, not a subscription. Only the later explicit
structure commands (create child/sibling) and `Arrange mind map` may invoke it.
Pointer move, editor `onChange`, remote receipt, save, restore and reconnect
must never invoke it. The initiating client will materialize a result in one
`SceneCapability.apply` call and one undo capture.

Manual subtree drag is likewise geometric translation, not layout. The next
explicit structure/layout command intentionally resets v1 hand positions;
pinning and offset-preserving layout belong to NIL-571.
