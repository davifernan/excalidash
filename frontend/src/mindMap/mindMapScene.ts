/**
 * The two explicit mind-map commands that survive the mode teardown
 * (NIL-593, Schnitt 2): "Import mind map..." (an outline becomes a fresh
 * batch of ordinary, bound elements) and "Arrange" (an existing ambient
 * subtree gets one deterministic layout pass, respecting pinned nodes --
 * Schnitt 3, `../ambientTree/nodeState.ts`). Neither reads or writes
 * `customData.excalidash.mindMap`/`mindMapProjection` -- that relationship
 * layer, and the ~500-line scene-mutation engine this file used to be
 * (reparenting, drag-translate, integrity, collapse), is gone along with
 * the mode. What is left is small on purpose: two commands, one shared
 * layout-run counter. Pin/collapse themselves live in
 * `../ambientTree/nodeState.ts`, not here -- they are ambient facts about
 * any node, not a mind-map command.
 */
import type { ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import {
  ambientTreeRootedAt,
  type AmbientTreeNode,
  type ArrowEdge,
  type ShapeBox,
} from "../ambientTree/ambientTree";
import { pinnedNodeIds } from "../ambientTree/nodeState";
import {
  layoutMindMap,
  MIND_MAP_LAYOUT_V1,
  type MindMapTree,
  type MindMapTreeNode,
} from "./layout";
import {
  arrowGeometryBetween,
  createImportEdge,
  createImportNode,
  mergeEdgeBinding,
  newImportElementId,
} from "./importElements";
import type { ImportedNode } from "./outlineParser";

/**
 * NIL-570's own promise, unchanged by the teardown: layout never runs on
 * its own, only from an explicit command a user triggered ("Import" or
 * "Arrange"). This counter is the test hook that proves it --
 * `getMindMapLayoutRunCount` in `Editor.tsx` exposes it to e2e specs, which
 * assert it stays 0 on a client that only *received* a remote scene change
 * and never ran either command itself (`ambient-tree-drag.spec.ts` and
 * this ticket's own convergence proof).
 */
let layoutRunCount = 0;
export const mindMapLayoutRunCount = (): number => layoutRunCount;

const flattenPreorder = (root: MindMapTreeNode): readonly MindMapTreeNode[] => {
  const nodes: MindMapTreeNode[] = [];
  const visit = (node: MindMapTreeNode) => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return nodes;
};

const ambientToLayoutTree = (root: AmbientTreeNode): MindMapTree => {
  const convert = (node: AmbientTreeNode): MindMapTreeNode => ({
    elementId: node.id,
    children: node.children.map(convert),
  });
  const layoutRoot = convert(root);
  return { root: layoutRoot, nodes: flattenPreorder(layoutRoot) };
};

const toImportTree = (
  root: ImportedNode,
): { readonly map: MindMapTree; readonly textById: Map<string, string> } => {
  const textById = new Map<string, string>();
  const convert = (node: ImportedNode): MindMapTreeNode => {
    const elementId = newImportElementId();
    textById.set(elementId, node.text);
    return { elementId, children: node.children.map(convert) };
  };
  const layoutRoot = convert(root);
  return { map: { root: layoutRoot, nodes: flattenPreorder(layoutRoot) }, textById };
};

/**
 * Materialize a parsed outline (NIL-572/593) as one brand-new batch of
 * ordinary elements: every node a real rectangle with its text already set
 * (an import has no "start typing" moment to defer a label to), one real
 * bound arrow per parent-child edge, exactly ONE deterministic layout run
 * over the whole new tree, and one `select` on the root. No `customData`
 * relationship is ever written -- the result is indistinguishable
 * afterward from a tree drawn by hand, and `ambientTree/`'s drag-follow
 * (Schnitt 1) already works on it without any change.
 */
export function importOps(
  root: ImportedNode,
  anchor: { readonly x: number; readonly y: number },
): { readonly ops: readonly SceneOp[]; readonly rootId: string } {
  const { map, textById } = toImportTree(root);
  const positions = layoutMindMap(map, MIND_MAP_LAYOUT_V1, anchor);
  layoutRunCount += 1;

  const rectangleById = new Map<string, any>();
  const ops: SceneOp[] = [];
  for (const position of positions) {
    const text = textById.get(position.elementId)!;
    const built = createImportNode(position.elementId, position.x, position.y, text);
    rectangleById.set(position.elementId, built.rectangle);
    ops.push({ kind: "insert", elements: [built.rectangle, built.label] });
  }

  const boxOf = (
    elementId: string,
  ): {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } => {
    const rectangle = rectangleById.get(elementId);
    return {
      id: elementId,
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
    };
  };

  const patchedBoundElements = new Map<string, any[]>();
  const edgeOps: SceneOp[] = [];
  for (const node of map.nodes) {
    for (const child of node.children) {
      const arrowId = newImportElementId();
      const arrow = createImportEdge(arrowId, boxOf(node.elementId), boxOf(child.elementId));
      edgeOps.push({ kind: "insert", elements: [arrow] });

      const parentRectangle = rectangleById.get(node.elementId);
      const parentBound =
        patchedBoundElements.get(node.elementId) ?? parentRectangle.boundElements ?? [];
      const nextParentBound = mergeEdgeBinding(parentBound, [
        { id: arrowId as never, type: "arrow" },
      ]);
      patchedBoundElements.set(node.elementId, nextParentBound as any[]);

      const childRectangle = rectangleById.get(child.elementId);
      const childBound =
        patchedBoundElements.get(child.elementId) ?? childRectangle.boundElements ?? [];
      const nextChildBound = mergeEdgeBinding(childBound, [
        { id: arrowId as never, type: "arrow" },
      ]);
      patchedBoundElements.set(child.elementId, nextChildBound as any[]);
    }
  }

  const bindingOps: SceneOp[] = [...patchedBoundElements.entries()].map(
    ([elementId, boundElements]) => ({
      kind: "patch",
      id: elementId as never,
      changes: { boundElements } as never,
    }),
  );

  return {
    ops: [
      ...ops,
      ...edgeOps,
      ...bindingOps,
      { kind: "select", ids: [map.root.elementId] as never },
    ],
    rootId: map.root.elementId,
  };
}

/**
 * The explicit "Arrange" command (NIL-593, Schnitt 2): recompute the
 * layout of the ambient subtree rooted at `rootId`, given the board's
 * current arrow bindings -- the exact same qualifying-children rule
 * `ambientTree/useAmbientTreeDrag.ts` uses for drag-follow, via
 * `ambientTreeRootedAt`. The root itself keeps its own current position
 * (an explicit command should not relocate the node the user selected);
 * only its descendants move. `null` when there is nothing to arrange: an
 * unknown root, a leaf with no qualifying children, or a cycle.
 */
export function arrangeOps(
  summaries: readonly ElementSummary[],
  rootId: string,
): readonly SceneOp[] | null {
  const shapes = summaries.filter((element) => !element.isDeleted && element.type !== "arrow");
  const rootSummary = shapes.find((shape) => shape.id === rootId);
  if (!rootSummary) return null;

  const boxesById = new Map<string, ShapeBox>(
    shapes.map((shape) => [
      shape.id,
      { id: shape.id, x: shape.x, y: shape.y, width: shape.width, height: shape.height },
    ]),
  );
  const edges: ArrowEdge[] = summaries
    .filter((element) => !element.isDeleted && element.type === "arrow")
    .map((arrow) => ({
      arrowId: arrow.id,
      startId: arrow.startBinding?.elementId ?? null,
      endId: arrow.endBinding?.elementId ?? null,
    }));

  const ambientRoot = ambientTreeRootedAt(rootId, edges, boxesById);
  if (!ambientRoot || ambientRoot.children.length === 0) return null;

  const map = ambientToLayoutTree(ambientRoot);
  const positions = layoutMindMap(map, MIND_MAP_LAYOUT_V1, { x: rootSummary.x, y: rootSummary.y });
  layoutRunCount += 1;

  // Pinned (NIL-593, Schnitt 3): `layoutMindMap` still computes an ideal
  // position for every node -- the pure core stays exactly as pure as
  // before -- but a pinned node's own hand-set position is exempt from
  // being overwritten here, the same "arrange respects this one exception"
  // contract v1 already had. Its children still lay out at their normal
  // computed positions (unadjusted for the pinned node's actual position),
  // matching v1's own documented behavior -- not a Schnitt 3 redesign.
  const pinned = pinnedNodeIds(summaries);

  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const ops: SceneOp[] = [];
  // Every box's position after this Arrange run -- the root keeps its own
  // (never patched), a pinned node keeps its own, everything else gets its
  // freshly laid out position. Feeds the edge-geometry recompute below:
  // unlike a live drag (`useAmbientTreeDrag.ts`), NONE of these moves is a
  // native Excalidraw drag, so NO bound arrow reflows on its own here, not
  // even the ones touching the root -- every edge inside the arranged
  // subtree needs its geometry recomputed explicitly via
  // `arrowGeometryBetween`.
  const finalBoxById = new Map(boxesById);
  for (const position of positions) {
    if (pinned.has(position.elementId)) continue; // keeps its own live box
    const box = finalBoxById.get(position.elementId);
    if (box) finalBoxById.set(position.elementId, { ...box, x: position.x, y: position.y });
  }

  for (const position of positions) {
    if (position.elementId === rootId) continue; // the root anchor stays put
    if (pinned.has(position.elementId)) continue; // hand-set position: no move, no patch
    const summary = summaryById.get(position.elementId as never);
    if (!summary) continue;
    if (summary.x === position.x && summary.y === position.y) continue;
    ops.push({
      kind: "patch",
      id: position.elementId as never,
      changes: { x: position.x, y: position.y },
    });

    const label = summaries.find((element) => element.containerId === position.elementId);
    if (label) {
      ops.push({
        kind: "patch",
        id: label.id as never,
        changes: { x: label.x + (position.x - summary.x), y: label.y + (position.y - summary.y) },
      });
    }
  }

  // Recompute geometry for every edge inside the arranged subtree -- the
  // node-position patches above never trigger Excalidraw's own reflow (see
  // the comment on `finalBoxById`), so a bound arrow left alone here would
  // stay visually attached to where its endpoints used to be.
  const arrangedIds = new Set(map.nodes.map((treeNode) => treeNode.elementId));
  for (const edge of edges) {
    if (!edge.startId || !edge.endId) continue;
    if (!arrangedIds.has(edge.startId) || !arrangedIds.has(edge.endId)) continue;
    const parentBox = finalBoxById.get(edge.startId);
    const childBox = finalBoxById.get(edge.endId);
    if (!parentBox || !childBox) continue;
    const geometry = arrowGeometryBetween(parentBox, childBox);
    ops.push({
      kind: "patch",
      id: edge.arrowId as never,
      changes: { x: geometry.x, y: geometry.y, points: geometry.points } as never,
    });
  }

  return ops;
}
