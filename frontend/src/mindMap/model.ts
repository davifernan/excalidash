import type { MindMapRecord } from "../integrations/excalidraw/customData";

export type MindMapNodeInput = {
  readonly elementId: string;
  readonly relation: MindMapRecord;
};

export type NormalizedMindMapNode = {
  readonly elementId: string;
  readonly mapId: string;
  readonly parentId: string | null;
  readonly orderKey: string;
  readonly children: readonly NormalizedMindMapNode[];
};

export type NormalizedMindMap = {
  readonly mapId: string;
  readonly rootId: string;
  readonly root: NormalizedMindMapNode;
  /** Stable pre-order, useful for one batched scene update. */
  readonly nodes: readonly NormalizedMindMapNode[];
};

export type MindMapIntegrityCode =
  | "duplicate-element"
  | "missing-root"
  | "multiple-roots"
  | "missing-parent"
  | "cross-map-parent"
  | "cycle";

export type MindMapIntegrityDiagnostic = {
  readonly code: MindMapIntegrityCode;
  readonly elementIds: readonly string[];
  readonly parentId?: string;
};

export type MindMapNormalizationResult =
  | { readonly ok: true; readonly value: NormalizedMindMap }
  | {
      readonly ok: false;
      readonly mapId: string;
      readonly diagnostics: readonly MindMapIntegrityDiagnostic[];
      /**
       * Invalid semantic data never causes a destructive repair. The caller
       * leaves ordinary rectangles, labels, arrows, coordinates and customData
       * untouched and can surface these diagnostics to the user.
       */
      readonly behavior: "preserve-scene";
    };

/** Locale-independent ordering; `localeCompare` can vary with client locale. */
export const compareStableStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareMindMapSiblings = (
  left: Pick<MindMapNodeInput, "elementId" | "relation">,
  right: Pick<MindMapNodeInput, "elementId" | "relation">,
): number =>
  compareStableStrings(left.relation.orderKey, right.relation.orderKey) ||
  compareStableStrings(left.elementId, right.elementId);

const compareDiagnostics = (
  left: MindMapIntegrityDiagnostic,
  right: MindMapIntegrityDiagnostic,
): number =>
  compareStableStrings(left.code, right.code) ||
  compareStableStrings(left.elementIds.join("\u0000"), right.elementIds.join("\u0000")) ||
  compareStableStrings(left.parentId ?? "", right.parentId ?? "");

const findCycles = (
  nodes: readonly MindMapNodeInput[],
  sameMapById: ReadonlyMap<string, MindMapNodeInput>,
): MindMapIntegrityDiagnostic[] => {
  const cycles = new Map<string, readonly string[]>();

  for (const start of nodes) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: MindMapNodeInput | undefined = start;

    while (current) {
      const seenAt = pathIndex.get(current.elementId);
      if (seenAt !== undefined) {
        const members = path.slice(seenAt).sort(compareStableStrings);
        cycles.set(members.join("\u0000"), members);
        break;
      }

      pathIndex.set(current.elementId, path.length);
      path.push(current.elementId);
      current = current.relation.parentId ? sameMapById.get(current.relation.parentId) : undefined;
    }
  }

  return [...cycles.values()].map((elementIds) => ({ code: "cycle", elementIds }));
};

/**
 * Validate and normalize one map without changing the supplied records.
 *
 * A map with an orphan, cross-map edge, duplicate element id, root ambiguity
 * or cycle is returned as `preserve-scene`. Failing closed is intentional: an
 * automatic guess would overwrite visible hand positions or silently invent a
 * different tree on another client.
 */
export const normalizeMindMap = (
  allNodes: readonly MindMapNodeInput[],
  mapId: string,
): MindMapNormalizationResult => {
  const nodes = allNodes
    .filter((node) => node.relation.mapId === mapId)
    .slice()
    .sort((left, right) => compareStableStrings(left.elementId, right.elementId));
  const allById = new Map<string, MindMapNodeInput[]>();
  for (const node of allNodes) {
    const entries = allById.get(node.elementId) ?? [];
    entries.push(node);
    allById.set(node.elementId, entries);
  }

  const diagnostics: MindMapIntegrityDiagnostic[] = [];
  for (const [elementId, entries] of allById) {
    if (entries.length > 1 && entries.some((entry) => entry.relation.mapId === mapId)) {
      diagnostics.push({ code: "duplicate-element", elementIds: [elementId] });
    }
  }

  const roots = nodes.filter((node) => node.relation.parentId === null);
  if (roots.length === 0) {
    diagnostics.push({ code: "missing-root", elementIds: nodes.map((node) => node.elementId) });
  } else if (roots.length > 1) {
    diagnostics.push({
      code: "multiple-roots",
      elementIds: roots.map((node) => node.elementId).sort(compareStableStrings),
    });
  }

  const sameMapById = new Map<string, MindMapNodeInput>();
  for (const node of nodes) {
    if (!sameMapById.has(node.elementId)) sameMapById.set(node.elementId, node);
  }

  for (const node of nodes) {
    const parentId = node.relation.parentId;
    if (parentId === null) continue;
    const parents = allById.get(parentId) ?? [];
    if (parents.length === 0) {
      diagnostics.push({ code: "missing-parent", elementIds: [node.elementId], parentId });
    } else if (!parents.some((parent) => parent.relation.mapId === mapId)) {
      diagnostics.push({ code: "cross-map-parent", elementIds: [node.elementId], parentId });
    }
  }

  diagnostics.push(...findCycles(nodes, sameMapById));
  if (diagnostics.length > 0) {
    return {
      ok: false,
      mapId,
      diagnostics: diagnostics.sort(compareDiagnostics),
      behavior: "preserve-scene",
    };
  }

  const root = roots[0];
  if (!root) {
    throw new Error("mind-map normalization invariant: validated map has no root");
  }

  const childrenByParent = new Map<string, MindMapNodeInput[]>();
  for (const node of nodes) {
    const parentId = node.relation.parentId;
    if (parentId === null) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(node);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareMindMapSiblings);

  const build = (node: MindMapNodeInput): NormalizedMindMapNode => ({
    elementId: node.elementId,
    mapId: node.relation.mapId,
    parentId: node.relation.parentId,
    orderKey: node.relation.orderKey,
    children: (childrenByParent.get(node.elementId) ?? []).map(build),
  });
  const normalizedRoot = build(root);
  const preorder: NormalizedMindMapNode[] = [];
  const visit = (node: NormalizedMindMapNode): void => {
    preorder.push(node);
    node.children.forEach(visit);
  };
  visit(normalizedRoot);

  return {
    ok: true,
    value: { mapId, rootId: root.elementId, root: normalizedRoot, nodes: preorder },
  };
};

export const subtreeElementIds = (map: NormalizedMindMap, rootId: string): readonly string[] => {
  const root = map.nodes.find((node) => node.elementId === rootId);
  if (!root) return [];
  const ids: string[] = [];
  const visit = (node: NormalizedMindMapNode): void => {
    ids.push(node.elementId);
    node.children.forEach(visit);
  };
  visit(root);
  return ids;
};
