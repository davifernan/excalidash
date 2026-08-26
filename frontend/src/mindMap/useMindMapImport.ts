/**
 * The "Import mind map..." command's own state and write (NIL-572/593):
 * open/close the dialog, and turn a successfully-parsed outline into the
 * one atomic write `importOps` (`mindMapScene.ts`) describes -- one
 * `scene.apply`, one undo step, exactly one deterministic layout run, same
 * as every other explicit mind-map command. The written elements are
 * ordinary rectangles and bound arrows; nothing here writes
 * `customData.excalidash.mindMap`.
 *
 * The anchor is the current viewport's own centre, converted to scene
 * space: a menu command has no click point to anchor to the way arming the
 * old mind-map tool and clicking the canvas once did, and "wherever the
 * user is currently looking" is the least surprising default.
 */
import { useState } from "react";
import type { SceneCapability, ViewportCapability } from "../integrations/excalidraw/capabilities";
import { MIND_MAP_LAYOUT_V1 } from "./layout";
import { importOps } from "./mindMapScene";
import type { ImportedNode } from "./outlineParser";

type Options = {
  canEdit: boolean;
  scene: Pick<SceneCapability, "apply">;
  viewport: Pick<ViewportCapability, "visibleBounds">;
};

export function useMindMapImport({ canEdit, scene, viewport }: Options) {
  const [isOpen, setIsOpen] = useState(false);

  const open = () => {
    if (canEdit) setIsOpen(true);
  };
  const close = () => setIsOpen(false);

  /** Writes the parsed tree into the scene. Returns whether the write succeeded. */
  const runImport = (root: ImportedNode): boolean => {
    if (!canEdit) return false;

    const bounds = viewport.visibleBounds();
    const anchor = bounds.ok
      ? {
          x: (bounds.value[0] + bounds.value[2]) / 2 - MIND_MAP_LAYOUT_V1.nodeWidth / 2,
          y: (bounds.value[1] + bounds.value[3]) / 2 - MIND_MAP_LAYOUT_V1.nodeHeight / 2,
        }
      : { x: 0, y: 0 };

    const { ops } = importOps(root, anchor);
    // `capture: "eventually"`, not `"immediate"` -- the same measured fix
    // `useAmbientTreeDrag.ts` documents for the same shape of bug: this
    // batch's own `select` op changes `appState.selectedElementIds` in the
    // very same `updateScene` call as the element insert, which is exactly
    // the "selection is still forming in this call" case that file found
    // breaks `IMMEDIATELY`'s checkpoint (there: split into several undo
    // steps; here: no checkpoint at all, so Ctrl+Z after import did
    // nothing). `"eventually"` defers to the next natural checkpoint and
    // measured correctly there; NIL-593's own e2e proof
    // (`mind-map-teardown.spec.ts`) is what caught this for import.
    const applied = scene.apply(ops, { capture: "eventually" });
    if (applied.ok) setIsOpen(false);
    return applied.ok;
  };

  return { isOpen, open, close, runImport };
}
