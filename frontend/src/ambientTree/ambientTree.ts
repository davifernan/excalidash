/**
 * Which shapes follow a dragged shape, given nothing but the board's own
 * native arrow bindings (NIL-593).
 *
 * The mind-map tool (NIL-570/571) stored its tree in
 * `customData.excalidash.mindMap` -- a mode you had to opt into. This is the
 * opposite: no mode, no customData, no persisted state at all. The
 * "structure" a drag follows is recomputed fresh, every drag, purely from
 * `startBinding`/`endBinding` on arrows and each shape's own live position.
 * Nothing here is a mind map; this module has never heard of one.
 *
 * ## Why "every arrow is a tree edge" is wrong, and what replaces it
 *
 * A flowchart arrow means "flows to", not "is a child of". Taking that
 * literally would drag boxes on every existing flowchart board the moment
 * someone repositions one shape. Three concrete failure shapes, and the
 * rule chosen for each:
 *
 * 1. **Direction.** Only an OUTGOING bound arrow (the dragged shape is the
 *    arrow's `startBinding`) names a candidate child -- matches the
 *    product description literally ("zieht mit, worauf es zeigt"). An
 *    incoming arrow never pulls its source along.
 * 2. **Multiple parents (breaking point 3 in the ticket).** A candidate
 *    child only counts if it has EXACTLY ONE incoming candidate edge across
 *    the WHOLE board, not just from the shape being dragged. A flowchart
 *    merge point -- two branches converging into one box -- has two, so it
 *    is excluded from EITHER branch's drag, unconditionally.
 * 3. **A decision point (also breaking point 1, the sharper form of it).**
 *    A shape's own outgoing arrows must all point in the same coarse
 *    compass direction (`right`/`left`/`up`/`down`, by whichever axis
 *    dominates) for that shape to contribute ANY children at all. A
 *    flowchart decision diamond's branches almost always diverge in
 *    direction (one down, one sideways); a mind-map hub's children, even
 *    spread across a wide vertical span, are all on the same side of their
 *    parent (this fork's own left-to-right layout convention, NIL-570).
 *    One outgoing arrow is trivially "one direction" and always qualifies.
 * 4. **Cycles (breaking point 2).** `A -> B -> C -> A` is a legal drawing.
 *    Detected during the walk (a candidate child already on the current
 *    path, or equal to the dragged shape itself) aborts the WHOLE result to
 *    empty -- not a partial subtree up to the cycle. Silence over a
 *    confusing partial drag.
 *
 * ## The honest gap this rule does not close
 *
 * A plain two-box chain (`A -> B`, both ends bound, both single-in/
 * single-out) is graph-theoretically identical whether `A -> B` means
 * "flows to" or "is the parent of". Nothing in this module -- or, we
 * believe, in the shape of the graph alone -- can tell those apart. The
 * practical consequence: dragging a box that sits on a plain chain link
 * (no branching before or after it) pulls its one successor along, even on
 * a flowchart. The blast radius is bounded to that one hop, though: rule 3
 * stops it from ever cascading past a genuine branch or merge point, which
 * is where an existing flowchart board actually breaks if it breaks at
 * all. The fixture and tests in `ambientTree.test.ts` cover both the
 * protected case (dragging a decision point) and the acknowledged one
 * (dragging a plain chain link).
 */

export type ArrowEdge = {
  readonly arrowId: string;
  readonly startId: string | null;
  readonly endId: string | null;
};

export type ShapeBox = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type Direction = "left" | "right" | "up" | "down";

const centerOf = (box: ShapeBox): { readonly x: number; readonly y: number } => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

const directionOf = (from: ShapeBox, to: ShapeBox): Direction => {
  const a = centerOf(from);
  const b = centerOf(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "down" : "up";
};

/**
 * Every shape id that should move along with `draggedId`, given the
 * board's current arrow bindings and shape positions. Never includes
 * `draggedId` itself. Empty when nothing qualifies, including the cycle
 * case (see the file comment) -- an empty result is this module's normal
 * way of staying silent, not a failure.
 */
export function ambientSubtreeIds(
  draggedId: string,
  edges: readonly ArrowEdge[],
  boxesById: ReadonlyMap<string, ShapeBox>,
): ReadonlySet<string> {
  const outgoingByShape = new Map<string, { readonly childId: string }[]>();
  const incomingCount = new Map<string, number>();

  for (const edge of edges) {
    if (!edge.startId || !edge.endId) continue; // both ends must be real bindings
    if (edge.startId === edge.endId) continue; // a self-loop is never a tree edge
    if (!boxesById.has(edge.startId) || !boxesById.has(edge.endId)) continue;
    const list = outgoingByShape.get(edge.startId) ?? [];
    list.push({ childId: edge.endId });
    outgoingByShape.set(edge.startId, list);
    incomingCount.set(edge.endId, (incomingCount.get(edge.endId) ?? 0) + 1);
  }

  /** The children `shapeId` contributes, or none if its own outgoing set disagrees on direction. */
  const qualifyingChildren = (shapeId: string): readonly string[] => {
    const outs = outgoingByShape.get(shapeId) ?? [];
    const singleParentOuts = outs.filter((out) => (incomingCount.get(out.childId) ?? 0) === 1);
    if (singleParentOuts.length === 0) return [];
    const from = boxesById.get(shapeId);
    if (!from) return [];
    const directions = new Set(
      singleParentOuts.map((out) => directionOf(from, boxesById.get(out.childId)!)),
    );
    if (directions.size > 1) return [];
    return singleParentOuts.map((out) => out.childId);
  };

  const visited = new Set<string>();
  const path = new Set<string>([draggedId]);
  let cycleFound = false;

  const visit = (shapeId: string): void => {
    if (cycleFound) return;
    for (const childId of qualifyingChildren(shapeId)) {
      if (childId === draggedId || path.has(childId)) {
        cycleFound = true;
        return;
      }
      if (visited.has(childId)) continue; // ruled out by construction (single-parent), kept defensive
      visited.add(childId);
      path.add(childId);
      visit(childId);
      path.delete(childId);
      if (cycleFound) return;
    }
  };

  visit(draggedId);
  return cycleFound ? new Set() : visited;
}
