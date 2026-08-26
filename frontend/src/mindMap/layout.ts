import { hierarchy, tree } from "d3-hierarchy";

/**
 * A generic labeled tree -- what the layout core actually reads, nothing
 * more (NIL-593, Schnitt 2: used to be `NormalizedMindMap`/
 * `NormalizedMindMapNode` from the now-deleted `model.ts`, which carried
 * `mapId`/`parentId`/`orderKey` for its OWN validation pass; this file
 * never read those three fields, only `elementId` and `children`, so they
 * are gone from the type along with the module that needed them). Any
 * caller can build this shape: `mindMapScene.ts`'s "Arrange" from the
 * ambient graph, its "import" from a freshly parsed outline -- this file
 * stays exactly as unaware of where the tree came from as it always was.
 */
export type MindMapTreeNode = {
  readonly elementId: string;
  readonly children: readonly MindMapTreeNode[];
};

export type MindMapTree = {
  readonly root: MindMapTreeNode;
  /** Stable pre-order, useful for one batched scene update. */
  readonly nodes: readonly MindMapTreeNode[];
};

export type MindMapLayoutConfig = {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly levelGap: number;
  readonly siblingGap: number;
};

export type MindMapRootAnchor = {
  /** Top-left scene coordinate of the root rectangle. */
  readonly x: number;
  readonly y: number;
};

export type MindMapLayoutPosition = {
  readonly elementId: string;
  /** Top-left scene coordinate of the fixed-size node rectangle. */
  readonly x: number;
  readonly y: number;
};

export const MIND_MAP_LAYOUT_V1: MindMapLayoutConfig = Object.freeze({
  nodeWidth: 200,
  nodeHeight: 80,
  levelGap: 120,
  siblingGap: 40,
});

const assertFiniteNonNegative = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Mind-map layout ${name} must be a finite non-negative number.`);
  }
};

const validateInputs = (config: MindMapLayoutConfig, anchor: MindMapRootAnchor): void => {
  assertFiniteNonNegative(config.nodeWidth, "nodeWidth");
  assertFiniteNonNegative(config.nodeHeight, "nodeHeight");
  assertFiniteNonNegative(config.levelGap, "levelGap");
  assertFiniteNonNegative(config.siblingGap, "siblingGap");
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    throw new Error("Mind-map root anchor must use finite scene coordinates.");
  }
};

/**
 * Pure deterministic v1 layout.
 *
 * The normalized tree already carries the client-independent
 * `(orderKey, elementId)` sibling order. D3's Buchheim/Reingold-Tilford
 * implementation receives only that structure and fixed spacing. It sees no
 * DOM, viewport, selection, time, randomness or collaboration state.
 *
 * `tree().nodeSize()` places the root at (0, 0), with x as breadth and y as
 * depth. Swapping those axes produces the product's one supported v1
 * orientation: left to right. The supplied root top-left remains fixed.
 */
export const layoutMindMap = (
  map: MindMapTree,
  config: MindMapLayoutConfig,
  rootAnchor: MindMapRootAnchor,
): readonly MindMapLayoutPosition[] => {
  validateInputs(config, rootAnchor);

  const root = hierarchy<MindMapTreeNode>(map.root, (node) => node.children);
  const laidOut = tree<MindMapTreeNode>().nodeSize([
    config.nodeHeight + config.siblingGap,
    config.nodeWidth + config.levelGap,
  ])(root);
  const byId = new Map(
    laidOut.descendants().map((node) => [
      node.data.elementId,
      {
        elementId: node.data.elementId,
        x: rootAnchor.x + node.y,
        y: rootAnchor.y + node.x,
      },
    ]),
  );

  return map.nodes.map((node) => {
    const position = byId.get(node.elementId);
    if (!position) {
      throw new Error(`Mind-map layout invariant: missing node ${node.elementId}.`);
    }
    return position;
  });
};
