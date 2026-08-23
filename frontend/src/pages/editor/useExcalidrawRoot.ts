/**
 * The Excalidraw root belonging to this editor.
 *
 * Chrome of ours that wants to sit *inside* that root — rather than in a layer
 * of our own above it — has to find the element first. Rendering there is worth
 * the trouble twice over: the island inherits Excalidraw's own colour tokens, so
 * light and dark match without us restating them, and it inherits
 * `--ui-pointerEvents`, which Excalidraw switches off while somebody is drawing,
 * dragging or resizing. Chrome that lets you draw straight through it does not
 * need to hide.
 *
 * Scoped to the container rather than found document-wide: two editors on one
 * page would otherwise both hang their chrome on the first one.
 */
import { useEffect, useState } from "react";
import type React from "react";

import { findRoot, observeStructure } from "../../integrations/excalidraw/domBridge";

export function useExcalidrawRoot(containerRef: React.RefObject<HTMLElement>): HTMLElement | null {
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const find = () => {
      const result = findRoot(container);
      const found = result.ok ? result.value : null;
      setRoot((current) => (current === found ? current : found));
    };

    find();
    // The editor is remounted when the drawing changes, and the portal has to
    // follow it rather than point at a detached node.
    return observeStructure(container, find);
  }, [containerRef]);

  return root;
}
