/**
 * Keeping every mind map on the board usable after Delete, Duplicate,
 * Copy/Paste and Undo/Redo -- the "expensive part" NIL-570 calls out, and
 * the reason this file exists apart from `mindMapScene.ts`'s pure ops.
 *
 * `model.ts`'s own `normalizeMindMap` already decides most of this by
 * itself, deliberately without this file's help:
 *
 * - **Duplicate / copy-paste** never gets special-cased here because
 *   Excalidraw does not remap ids inside `customData` when it duplicates or
 *   pastes elements (only its own `startBinding`/`endBinding`/`containerId`
 *   are id-aware). A duplicated child keeps `parentId` pointing at the
 *   original, still-live parent -- which reads as "a second copy of this
 *   branch, grafted back onto the same parent", not corruption, and needs no
 *   cleanup. A duplicated *root* produces two `parentId: null` nodes in one
 *   `mapId`, which `normalizeMindMap` already refuses to normalize
 *   (`multiple-roots`, `preserve-scene`) -- proven by `model.test.ts`
 *   already, not re-proven here.
 * - **Cycle, multiple-roots, duplicate-element, and any cross-map-parent
 *   this package's own writes did not just create** are left exactly where
 *   `normalizeMindMap` put them: visible, unrepaired, `preserve-scene`. That
 *   contract is model.ts's own choice (its file comment: "an automatic guess
 *   would overwrite visible hand positions or silently invent a different
 *   tree on another client"), and this file does not second-guess it.
 * - **Empty bound text** needs nothing here either: Excalidraw discards an
 *   empty bound label itself (`stickyNote.ts`'s file comment says the same
 *   for notes), leaving an ordinary, structurally untouched node.
 *
 * What genuinely needs active cleanup is **delete**: removing a non-leaf
 * node leaves its children pointing at a parent id that is simply gone
 * (`missing-parent`), or -- if the deleted id gets reused across maps some
 * day -- `cross-map-parent`. Left alone, `normalizeMindMap` correctly
 * refuses the *whole map*, which would permanently disable Tab/Enter/Arrange
 * on it until someone manually deletes the orphans by hand. This hook
 * removes exactly those orphans, and their own descendants and dangling
 * edges, immediately -- so the map stays valid (and usable) rather than
 * merely "diagnosed".
 *
 * The cleanup is folded into the deleting gesture's own history step
 * (`capture: "never"`), the same choice `useStickyUpkeep.ts` makes for its
 * own repairs: it is bookkeeping alongside the user's action, not a second
 * action of its own to undo separately.
 */
import { useCallback, useRef } from "react";
import type { SceneCapability } from "../integrations/excalidraw/capabilities";
import type { ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { readMindMapProjection } from "../integrations/excalidraw/customData";
import { readMindMapEdges, readMindMapNodes } from "./mindMapScene";
import { normalizeMindMap, type MindMapNodeInput } from "./model";

type Options = {
  canEdit: boolean;
  scene: Pick<SceneCapability, "apply" | "summaries">;
};

const ORPHAN_CODES = new Set(["missing-parent", "cross-map-parent"]);

/** Every orphan id, cascaded to its own descendants within the same map. */
function cascadeOrphans(mapId: string, nodes: readonly MindMapNodeInput[]): ReadonlySet<string> {
  const normalized = normalizeMindMap(nodes, mapId);
  if (normalized.ok) return new Set();

  const orphanRoots = new Set<string>();
  for (const diagnostic of normalized.diagnostics) {
    if (ORPHAN_CODES.has(diagnostic.code))
      diagnostic.elementIds.forEach((id) => orphanRoots.add(id));
  }
  if (orphanRoots.size === 0) return new Set();

  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.relation.mapId !== mapId || node.relation.parentId === null) continue;
    const list = childrenByParent.get(node.relation.parentId) ?? [];
    list.push(node.elementId);
    childrenByParent.set(node.relation.parentId, list);
  }

  const toRemove = new Set<string>();
  const visit = (id: string): void => {
    if (toRemove.has(id)) return;
    toRemove.add(id);
    (childrenByParent.get(id) ?? []).forEach(visit);
  };
  orphanRoots.forEach(visit);
  return toRemove;
}

/** Pure: which elements to remove, given the live board. Exported for a DOM-free test. */
export function integrityCleanupOps(summaries: readonly ElementSummary[]): SceneOp[] {
  const mindMapNodes = readMindMapNodes(summaries);
  const nodeInputs: MindMapNodeInput[] = mindMapNodes.map((node) => ({
    elementId: node.summary.id,
    relation: node.relation,
  }));
  const mapIds = new Set(mindMapNodes.map((node) => node.relation.mapId));
  const edgesByMap = readMindMapEdges(summaries);

  const toRemove = new Set<string>();
  for (const mapId of mapIds) {
    for (const id of cascadeOrphans(mapId, nodeInputs)) toRemove.add(id);
  }
  if (toRemove.size === 0) return [];

  for (const [, edges] of edgesByMap) {
    for (const edge of edges) {
      const projection = readMindMapProjection(edge);
      if (projection && toRemove.has(projection.childId)) toRemove.add(edge.id);
    }
  }

  return [{ kind: "remove", ids: [...toRemove] as never }];
}

export function useMindMapIntegrity({ canEdit, scene }: Options) {
  const queued = useRef(false);

  const onSceneChange = useCallback(
    (elements: readonly any[]) => {
      if (!canEdit || !elements?.length || queued.current) return;
      queued.current = true;
      queueMicrotask(() => {
        queued.current = false;
        const summaries = scene.summaries();
        if (!summaries.ok) return;
        const ops = integrityCleanupOps(summaries.value);
        if (ops.length > 0) scene.apply(ops, { capture: "never" });
      });
    },
    [canEdit, scene],
  );

  return { onSceneChange };
}
